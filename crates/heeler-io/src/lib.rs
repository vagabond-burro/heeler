//! Image decode/encode at the engine boundary.
//!
//! Decoding brings JPEG/PNG/TIFF into the engine's working representation:
//! linear RGBA f32 (`ImageBuf`). Non-RAW files without an embedded profile
//! are assumed sRGB. Matrix/TRC ICC input profiles are converted once at
//! ingestion; RAW development retains its existing output-space contract.

use std::io::Cursor;
use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder, ImageFormat, ImageReader};

use heeler_engine::ImageBuf;
use heeler_engine::memory::{self, Job, MemoryError};
use image::ImageDecoder;

pub mod exif;
pub mod metadata;
pub mod panasonic_tags;
pub use metadata::{read_all_metadata, MetaEntry};
pub use exif::{
    embed_jpeg_exif, embed_jpeg_xmp, embed_png_exif, embed_png_xmp, read_exif, write_exif_tiff,
    xmp_extent, ExifExportOptions, xmp_keywords_packet, XmpPacket, Exif, EXIF_READER_VERSION,
    RENDERED_XMP,
};
pub mod resolution;
pub use resolution::{set_jpeg_dpi, set_png_dpi, set_webp_dpi, DEFAULT_DPI};

pub mod icc;
mod fast_jpeg;
pub use fast_jpeg::encode_jpeg_fast;
pub mod input_color;
pub use icc::srgb_profile;

pub mod sidecar;
pub use sidecar::{read_sidecar, write_sidecar, Sidecar, TakeNote};

pub mod bake;
pub use bake::{
    baked_exposure, encode_baked_dng, encode_dng, encode_dng_with_xmp, encode_tiff16, encode_tiff16_export,
    TiffExportOptions, FloatTiffOptions, encode_tiff16_display_untagged, encode_tiff16_grey, encode_tiff16_layer, encode_tiff16_layer_display,
    encode_tiff32f, encode_tiff32f_grey,
    encode_tiff32f_layer, linear_headroom,
};

pub mod heic;
pub mod lensdb;
pub use heic::{decode_heif, is_heif};

pub mod raw_preview;
pub use raw_preview::{extract_raw_preview, media_orientation, raw_orientation};

pub mod dng_jxl;
/// The rendering a phone's DNG carries beside its pixels: baseline
/// exposure, the gain table map and the tone curve.
pub mod dng_gain;
/// OpenEXR: the beauty layer today, the render passes behind it next
///.
pub mod exr_passes;
/// Multi-page TIFF: the IFD walk and the per-page decode behind the
/// File node's layer param (26.3 Phase 6).
pub mod tiff_pages;
pub use dng_jxl::{decode_jxl_dng, is_jxl_dng, largest_frame};

#[derive(Debug, thiserror::Error)]
pub enum IoError {
    #[error("{0}")]
    Memory(#[from] MemoryError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("image decode/encode failed: {0}")]
    Image(#[from] image::ImageError),
    #[error("unsupported or unrecognized image format")]
    UnsupportedFormat,
    /// A format we recognize and still cannot read, with the reason. The
    /// difference from `UnsupportedFormat` matters to the user: "this is
    /// not an image" and "this is a JPEG XL DNG whose tiles I could not
    /// parse" deserve different answers.
    #[error("unsupported: {0}")]
    Unsupported(String),
    /// The file is not there, in one spelling on every platform.
    ///
    /// macOS says "No such file or directory (os error 2)". Windows says
    /// "The system cannot find the file specified. (os error 2)" when the
    /// file is gone and "the path specified. (os error 3)" when its folder
    /// went with it. The app's has-it-moved check (previewretry.ts) reads
    /// these words, so the spelling is settled here once rather than
    /// matched three ways there.
    #[error("io error: no such file or directory")]
    Missing,
    /// Any of the above, with the file it was about.
    ///
    /// The owner, reading `io error: No such file or directory (os error
    /// 2)` in the console: "What file? I don't know where to look to
    /// even understand how to fix this. It should show me the expected
    /// file path." He is right, and the fix belongs here rather than in
    /// the message he happened to be reading. By the time a failure
    /// reaches the app it has crossed the decoder, the source cache, the
    /// render command and the IPC boundary, and every one of those has
    /// thrown the path away; this crate is the last place that still has
    /// it. Naming it here answers the preview, the exporter, the
    /// thumbnail queue, the batch runner and the headless renderer at
    /// once.
    ///
    /// The path goes LAST so the sentence still reads as a sentence when
    /// a caller appends it to a line of its own, and so the part worth
    /// copying is at the end where it is easy to select.
    #[error("{source}: {path}")]
    At {
        path: String,
        #[source]
        source: Box<IoError>,
    },
}

/// Names the file in whatever went wrong with it.
///
/// Idempotent: a decoder that already named the file keeps its own
/// answer rather than collecting a second copy of the path.
fn naming(path: &Path, e: IoError) -> IoError {
    match e {
        IoError::At { .. } => e,
        IoError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
            IoError::At { path: path.display().to_string(), source: Box::new(IoError::Missing) }
        }
        other => IoError::At { path: path.display().to_string(), source: Box::new(other) },
    }
}

/// sRGB electro-optical transfer function (IEC 61966-2-1).
pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// A linear sample as the 8-bit sRGB code every encoder writes: the
/// transfer, clamped to 0..1, rounded to the nearest of 256 steps.
/// Written out as arithmetic, this is the one definition; srgb_u8 is
/// the same function read from a table.
#[inline]
fn srgb_u8_direct(v: f32) -> u8 {
    (linear_to_srgb(v).clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

/// The table's buckets: one per run of 2^14 float bit patterns below
/// 1.0, which is 512 buckets to every doubling of the value. The sRGB
/// curve rises less than a quarter of a code across any of them, so a
/// bucket holds at most one step: its code where it begins, and the
/// first value of the bucket that takes the next code.
const SRGB_LUT_SHIFT: u32 = 14;
const SRGB_LUT_LEN: usize = (0x3F80_0000u32 >> SRGB_LUT_SHIFT) as usize;

struct SrgbLut {
    base: Vec<u8>,
    step: Vec<f32>,
}

fn srgb_lut() -> &'static SrgbLut {
    static LUT: std::sync::OnceLock<SrgbLut> = std::sync::OnceLock::new();
    LUT.get_or_init(|| {
        let mut base = vec![0u8; SRGB_LUT_LEN];
        let mut step = vec![f32::INFINITY; SRGB_LUT_LEN];
        for b in 0..SRGB_LUT_LEN {
            let lo = (b as u32) << SRGB_LUT_SHIFT;
            let hi = lo + (1 << SRGB_LUT_SHIFT) - 1;
            let at_lo = srgb_u8_direct(f32::from_bits(lo));
            base[b] = at_lo;
            if srgb_u8_direct(f32::from_bits(hi)) > at_lo {
                // The first bit pattern past the step, by bisection.
                let (mut below, mut above) = (lo, hi);
                while above - below > 1 {
                    let mid = below + (above - below) / 2;
                    if srgb_u8_direct(f32::from_bits(mid)) > at_lo {
                        above = mid;
                    } else {
                        below = mid;
                    }
                }
                step[b] = f32::from_bits(above);
            }
        }
        SrgbLut { base, step }
    })
}

/// srgb_u8_direct, read from a table: the same code for every f32 (a
/// test walks all of them below 1.0), without a power per channel.
/// Every frame the viewer is sent paid three of those per pixel, about
/// half of a gesture frame's encode, and a slider drag is a stream of
/// those frames (a tester, 2026-09-30: "I do get a bit of jitter/lag
/// on the sliders").
#[inline]
pub fn srgb_u8(v: f32) -> u8 {
    // Zero, negatives and NaN all encode to 0; 1.0 and past it to 255.
    if !(v > 0.0) {
        return 0;
    }
    if v >= 1.0 {
        return 255;
    }
    let lut = srgb_lut();
    let b = (v.to_bits() >> SRGB_LUT_SHIFT) as usize;
    lut.base[b] + (v >= lut.step[b]) as u8
}

/// Decodes JPEG/PNG/TIFF bytes into a linear working-space buffer.
/// Handles 8- and 16-bit sources via the f32 conversion path.
pub fn decode_bytes(bytes: &[u8]) -> Result<ImageBuf, IoError> {
    decode_samples(bytes, true)
}

fn decode_samples(bytes: &[u8], linearize: bool) -> Result<ImageBuf, IoError> {
    // An EXR is scene-linear already and its color may sit under a layer
    // name the image crate cannot see; both reasons for its own reader.
    if exr_passes::is_exr(bytes) {
        return exr_passes::decode_beauty(bytes);
    }
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()
        .map_err(|_| IoError::UnsupportedFormat)?;
    let mut limits = image::Limits::no_limits();
    limits.max_alloc = Some(memory::available_to_job() as u64);
    reader.limits(limits.clone());
    let mut decoder = reader.into_decoder().map_err(|e| match e {
        image::ImageError::Limits(_) => IoError::Memory(MemoryError::Allocation("image decoder".into())),
        other => IoError::Image(other),
    })?;
    let (w, h) = decoder.dimensions();
    let needed = memory::sum([memory::bytes(w as usize, h as usize, 1, 48)?, bytes.len()])?;
    let _job = Job::admit(needed, "image decode, conversion and orientation")?;
    limits.max_alloc = Some(needed as u64);
    decoder.set_limits(limits)?;
    let color = decoder.color_type();
    let channels = color.channel_count() as usize;
    let sample_bytes = color.bytes_per_pixel() as usize / channels;
    let count = memory::bytes(w as usize, h as usize, channels, sample_bytes)?;
    if decoder.total_bytes() != count as u64 { return Err(IoError::UnsupportedFormat); }
    let mut decoded = memory::vector(count, 0u8, "decoded samples")?;
    let profile = if !linearize { Ok(None) }
        else if matches!(bytes.get(..2), Some(b"II" | b"MM")) { input_color::tiff_profile(&mut Cursor::new(bytes)) }
        else if bytes.starts_with(&[255,216]) { input_color::jpeg_profile(&mut Cursor::new(bytes)) }
        else {
            let extracted = decoder.icc_profile().map_err(|_| "cannot extract embedded ICC profile");
            if matches!(&extracted, Ok(None)) && bytes.starts_with(b"\x89PNG") && input_color::png_has_icc(&mut Cursor::new(bytes)).unwrap_or(false) {
                Err("cannot read embedded PNG ICC profile")
            } else { extracted }
        };
    decoder.read_image(&mut decoded)?;
    let mut out = ImageBuf::try_new(w as usize, h as usize)?;
    for (dest, pixel) in out.data.chunks_exact_mut(4).zip(decoded.chunks_exact(channels * sample_bytes)) {
        let sample = |c: usize| -> f32 {
            let at = c * sample_bytes;
            match sample_bytes {
                1 => pixel[at] as f32 / 255.0,
                2 => u16::from_ne_bytes(pixel[at..at + 2].try_into().unwrap()) as f32 / 65535.0,
                4 => f32::from_ne_bytes(pixel[at..at + 4].try_into().unwrap()),
                _ => unreachable!("image crate sample type"),
            }
        };
        if channels < 3 { dest[..3].fill(sample(0)); }
        else { for c in 0..3 { dest[c] = sample(c); } }
        dest[3] = if channels == 2 || channels == 4 { sample(channels - 1) } else { 1.0 };
    }
    // Float samples are scene-linear by convention in every tool that
    // writes them, Heeler's own 32-bit TIFF included; sending them
    // through the sRGB decode turned 0.5 into 0.21 and 2.0 into 4.95 on
    // the way back in (review, 2026-09-20). An integer file keeps its
    // transfer.
    if linearize && sample_bytes != 4 {
        input_color::ingest(&mut out, profile.as_ref().map(|p| p.as_deref()).map_err(|e| *e));
    }
    Ok(out)
}

/// Fallible file read with admission before reserving from the file length.
fn read_image(path: &Path) -> Result<Vec<u8>, IoError> {
    use std::io::Read;
    let file = std::fs::File::open(path)?;
    let len = usize::try_from(file.metadata()?.len()).map_err(|_| MemoryError::Geometry("image file".into()))?;
    let _job = Job::admit(memory::bytes(len, 1, 1, 1)?, "image file bytes")?;
    let mut bytes = memory::vector(len, 0u8, "image file bytes")?;
    file.take(len as u64).read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Header-only sizing for recipes retaining several decoded members.
/// Unknown formats remain subject to their decoder's own header admission.
pub struct DecodeEstimate { pub retained: usize, pub workspace: usize, pub width: usize, pub height: usize, pub encoded: usize }
impl DecodeEstimate {
    pub fn preview(&self, edge: usize) -> Result<(usize, usize), MemoryError> {
        let k = (edge as f64 / self.width.max(self.height).max(1) as f64).min(1.0);
        let output = memory::bytes((self.width as f64 * k).ceil() as usize, (self.height as f64 * k).ceil() as usize, 4, 4)?;
        // Native decoder storage plus the reduced conversion buffer. A decoder
        // needing more grows the same job, with earlier members still charged.
        Ok((output, memory::sum([self.retained, output, self.encoded, self.encoded])?))
    }
}
/// A header probe never needs more than the first few bytes of a JPEG or
/// PNG, or the first directory of a TIFF. The cap is generous so a RAW
/// wrapper's front matter still fits; a prefix that yields no dimensions
/// (a TIFF directory parked at the file's end) falls back to the full
/// read the probe used to start with.
const PROBE_PREFIX: usize = 8 * 1024 * 1024;

/// `prefix` says the bytes are a capped front of the file rather than the
/// whole of it. On a prefix, a RAW answers through LibRaw or not at all:
/// the standard readers see a TIFF-based RAW's first directory, which on
/// many cameras is a thumbnail, and a probe that reports 160 by 120 for a
/// 24 megapixel frame admits a stack it cannot hold. The whole file keeps
/// the fallback chain the probe always had.
fn estimate_from(bytes: &[u8], file_len: usize, raw_ext: bool, prefix: bool) -> Result<Option<DecodeEstimate>, IoError> {
    #[cfg(feature = "libraw")]
    let raw = if raw_ext { heeler_raw::dimensions(bytes).ok() } else { None };
    #[cfg(not(feature = "libraw"))]
    let raw: Option<(usize, usize)> = None;
    if raw.is_none() && raw_ext && prefix {
        return Ok(None);
    }
    let dims = raw.or_else(|| source_dimensions(bytes).map(|(w, h)| (w as usize, h as usize)));
    let Some((w, h)) = dims else { return Ok(None); };
    // Small pictures still need codec tables, metadata and inflate storage.
    // A GoPro GPR is developed from a rewritten copy carrying its decoded
    // samples, two bytes a pixel more than the file, which LibRaw's own
    // admission counts: without them a stack's fixed slice per frame came
    // up short and a full-size GPR stack was refused (the 26.5.1 review).
    #[cfg(feature = "libraw")]
    let rewritten = if raw_ext && heeler_raw::is_gpr(bytes) { memory::bytes(w, h, 1, 2)? } else { 0 };
    #[cfg(not(feature = "libraw"))]
    let rewritten = 0;
    Ok(Some(DecodeEstimate { width: w, height: h, encoded: file_len, retained: memory::bytes(w, h, 1, 16)?, workspace: memory::sum([memory::bytes(w, h, 1, 32)?, file_len, 64 << 10, rewritten])? }))
}

/// Header-only sizing for admission. Reads a capped prefix rather than
/// the whole file: every probed member of a stack or panorama is read
/// AGAIN at decode, and the full read here was a stall before the first
/// progress message, on top of paying the admission for bytes the probe
/// never looks at (a 40 MB member refused against a tight budget, when
/// its dimensions sat in the first kilobytes).
pub fn probe_memory(path: &Path) -> Result<Option<DecodeEstimate>, IoError> {
    use std::io::Read;
    at_boundary(path, || {
        let attempt = (|| -> Result<Option<DecodeEstimate>, IoError> {
            let file = std::fs::File::open(path)?;
            let file_len = usize::try_from(file.metadata()?.len()).map_err(|_| MemoryError::Geometry("image file".into()))?;
            let prefix_len = file_len.min(PROBE_PREFIX);
            let probed = {
                // Admit before reserving: memory::vector charges against
                // the active job's ceiling, and the boundary admitted zero.
                let _job = Job::admit(memory::bytes(prefix_len, 1, 1, 1)?, "image header bytes")?;
                let mut prefix = memory::vector(prefix_len, 0u8, "image header bytes")?;
                file.take(prefix_len as u64).read_exact(&mut prefix)?;
                estimate_from(&prefix, file_len, is_raw_extension(path), prefix_len < file_len)?
            };
            if probed.is_some() || prefix_len >= file_len {
                return Ok(probed);
            }
            // Dimensions parked past the prefix (a TIFF whose directory
            // sits at the file's end) still get the full read from before.
            let bytes = read_image(path)?;
            estimate_from(&bytes, file_len, is_raw_extension(path), false)
        })();
        // A member that vanished or will not read is unknown, not an
        // error: stack and panorama discovery list it as missing rather
        // than fail the whole set. Only a memory refusal stays an error.
        match attempt {
            Err(e) if memory::is_refusal(&e.to_string()) => Err(e),
            Err(_) => Ok(None),
            Ok(v) => Ok(v),
        }
    })
}

fn at_boundary<T>(path: &Path, f: impl FnOnce() -> Result<T, IoError>) -> Result<T, IoError> {
    let result = memory::catch(|| {
        let _job = Job::admit(0, "image work")?;
        input_color::named(path, f)
    }).map_err(IoError::from).and_then(|v| v);
    result.map_err(|e| naming(path, e))
}


pub fn decode_file(path: &Path) -> Result<ImageBuf, IoError> {
    at_boundary(path, || read_image(path).and_then(|b| decode_bytes(&b)))
}

/// Extensions handed to LibRaw. Every entry developed in the
/// raw.pixls.us corpus; what is not here either failed there outright
/// (X3F is Foveon, ARI, LRI, CAM) or was never seen. GoPro's GPR goes
/// to LibRaw too, after heeler-raw has decoded its VC-5 tile. The catalog must index each of these too, and a test below
/// holds the two lists together.
const RAW_EXTENSIONS: &[&str] = &[
    "dng", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
    "3fr", "iiq", "erf",
    // Canon CIFF, Leica and Panasonic compacts (.rwl, and the older .raw),
    // Olympus high-res originals, Hasselblad, Minolta, Kodak, Leaf,
    // Mamiya, Sony pixel-shift composites, Sinar, Minolta RD175. A .raw
    // from an action camera or a Pi is not a photograph LibRaw knows; it
    // fails or trips the noise gate and the file says so honestly.
    "crw", "rwl", "raw", "ori", "fff", "mrw", "kdc", "dcr", "mos", "mef", "arq", "sti", "mdc",
    // GoPro HERO5 on and Fusion: a DNG with a VC-5 tile (heeler-raw's gpr.rs).
    "gpr",
];

/// Whether the extension is one LibRaw is asked to develop. Public so the
/// support-matrix probe (examples/rawmatrix.rs) can report the same
/// answer the loader gives, next to what the catalog will index.
pub fn is_raw_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| RAW_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// LibRaw output is already linear (gamma 1.0, no auto-brighten), sRGB
/// primaries: straight normalization, no transfer function.
#[cfg(feature = "libraw")]
fn sensor_to_imagebuf(s: heeler_raw::SensorImage) -> ImageBuf {
    let mut out = ImageBuf::new(s.width, s.height);
    // headroom is 1.0 for plain clips; with highlight reconstruction
    // it restores the scale LibRaw withheld, so exposure holds still
    // across modes and reconstructed super-whites come through above
    // 1.0 for the tone profile's shoulder to roll off.
    let gain = s.headroom.max(1.0);
    for px in 0..s.width * s.height {
        let i = px * 3;
        let o = px * 4;
        out.data[o] = s.rgb[i] as f32 / 65535.0 * gain;
        out.data[o + 1] = s.rgb[i + 1] as f32 / 65535.0 * gain;
        out.data[o + 2] = s.rgb[i + 2] as f32 / 65535.0 * gain;
        out.data[o + 3] = 1.0;
    }
    out
}

/// Decodes any supported file. RAW files go through sensor-level LibRaw
/// develop when the `libraw` feature is on, falling back to the embedded
/// JPEG preview, then to the standard decoders.
pub fn decode_any(path: &Path) -> Result<ImageBuf, IoError> {
    decode_any_with(path, RawSourceOpts::default())
}

/// The pure-Rust decode path (rawler), the candidate to
/// replace the vendored LibRaw as primary. Same contract as the LibRaw
/// path: scene-linear, sRGB primaries, orientation applied. Evidence
/// first: behind the `rawler` feature, chosen at runtime only by
/// HEELER_DECODER=rawler, and the default flips only when the rawdiff
/// harness says the quality holds across the real library.
#[cfg(feature = "rawler")]
pub fn decode_rawler(path: &Path, bytes: &[u8]) -> Option<ImageBuf> {
    use rawler::imgop::develop::{Intermediate, ProcessingStep, RawDevelop};
    let _input = memory::or_unwind(Job::admit(memory::or_unwind(memory::bytes(bytes.len(), 2, 1, 1)), "RAW header input"));
    let probe = rawler::rawsource::RawSource::new_from_slice(bytes);
    let header = rawler::decode_dummy(&probe).ok()?;
    let needed = memory::or_unwind(memory::bytes(header.width, header.height, 1, 64));
    let _job = memory::or_unwind(Job::admit(needed, "RAW decode and develop"));
    let raw = rawler::decode_file(path).ok()?;

    let dev = RawDevelop {
        steps: vec![
            ProcessingStep::Rescale,
            ProcessingStep::Demosaic,
            ProcessingStep::CropActiveArea,
            ProcessingStep::WhiteBalance,
            ProcessingStep::Calibrate,
            ProcessingStep::CropDefault,
            // Deliberately no SRgb step: it applies gamma, and this
            // pipeline stays scene-linear until encode.
        ],
    };
    let developed = dev.develop_intermediate(&raw).ok()?;
    let Intermediate::ThreeColor(px) = developed else {
        return None;
    };
    let dim = px.dim();
    let flat = px.flatten();
    let mut img = ImageBuf::new(dim.w, dim.h);
    for p in 0..dim.w * dim.h {
        img.data[p * 4] = flat[p * 3];
        img.data[p * 4 + 1] = flat[p * 3 + 1];
        img.data[p * 4 + 2] = flat[p * 3 + 2];
        img.data[p * 4 + 3] = 1.0;
    }
    Some(apply_orientation(img, raw_orientation(bytes)))
}

/// Whether the runtime asked for the rawler path.
#[cfg(feature = "rawler")]
fn rawler_selected() -> bool {
    std::env::var("HEELER_DECODER").is_ok_and(|v| v.eq_ignore_ascii_case("rawler"))
}

/// Export-quality decode honoring the source node's develop toggles.
pub fn decode_any_with(path: &Path, opts: RawSourceOpts) -> Result<ImageBuf, IoError> {
    at_boundary(path, || decode_any_inner(path, opts, Pixels::AsTheFileRenders))
}

/// The same decode, with a phone DNG left scene-linear: the sensor
/// develop without the file's baseline exposure, gain table map and
/// tone curve. For a merge of exposures, which needs light in the
/// units the sensor counted (2026-10-03: "stacks use scene-linear,
/// panoramas keep phone rendering"); a tone-mapped frame has had its
/// shadows lifted and its highlights pulled by amounts that differ
/// across the frame. Every other file decodes as ever.
pub fn decode_any_scene_linear(path: &Path, opts: RawSourceOpts) -> Result<ImageBuf, IoError> {
    at_boundary(path, || decode_any_inner(path, opts, Pixels::SceneLinear))
}

/// What a decode hands back for a file that carries its own rendering.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pixels {
    /// Rendered by the file's instructions (src/dng_gain.rs): the
    /// picture, for viewing, editing and stitching.
    AsTheFileRenders,
    /// The develop alone, for a merge of exposures.
    SceneLinear,
}

impl Pixels {
    fn of(self, img: ImageBuf, bytes: &[u8]) -> ImageBuf {
        match self {
            Pixels::AsTheFileRenders => as_the_file_renders(img, bytes),
            Pixels::SceneLinear => img,
        }
    }
}

fn decode_any_inner(path: &Path, opts: RawSourceOpts, pixels: Pixels) -> Result<ImageBuf, IoError> {
    #[cfg(not(feature = "libraw"))]
    let _ = opts;
    let bytes = read_image(path)?;
    // A develop turned away as noise, for the error if nothing else reads
    // the file (rejected_develop).
    #[allow(unused_mut)]
    let mut rejected: Option<(usize, usize)> = None;
    if matches!(pixels, Pixels::SceneLinear) {
        if let Some(img) = decode_jpeg_reduced(&bytes, 0)? {
            return Ok(unbake(apply_orientation(img, media_orientation(&bytes)), &bytes));
        }
    }
    // HEIC through the OS codec, orientation already applied by the
    // decode; the image crate has no HEIF support, so without this the
    // file falls through to an honest UnsupportedFormat.
    if heic::is_heif(&bytes) {
        if let Some(img) = heic::decode_heif(&bytes) {
            return Ok(img);
        }
    }
    #[cfg(feature = "rawler")]
    if is_raw_extension(path) && rawler_selected() {
        if let Some(img) = decode_rawler(path, &bytes) {
            if develop_looks_sane(&img) {
                return Ok(unbake(pixels.of(img, &bytes), &bytes));
            }
        }
    }
    // JPEG XL DNG goes to our own decoder: LibRaw has no reader for it
    // and would fall through to the embedded preview, which on these
    // files can be 256 pixels wide. A failure here is returned rather
    // than swallowed, because at develop and export quality a wrong
    // picture is worse than an honest error.
    if is_raw_extension(path) && is_jxl_dng(&bytes) {
        return decode_jxl_dng(&bytes).map(|img| pixels.of(img, &bytes));
    }
    #[cfg(feature = "libraw")]
    if is_raw_extension(path) {
        let dev = heeler_raw::DevelopOpts {
            half_size: false,
            fixed_white: pixels == Pixels::SceneLinear,
            camera_wb: opts.camera_wb,
            camera_matrix: opts.camera_matrix,
            highlight: opts.highlight,
            demosaic: opts.demosaic,
        };
        let decoded = heeler_raw::decode_sensor_with(&bytes, dev);
        if let Err(heeler_raw::RawError::Memory(e)) = &decoded { return Err(e.clone().into()); }
        // A GPR has no embedded preview or readable strip to fall back on:
        // what follows would only misname the damage (a "JPEG SOF" or
        // "photometric" error for a cut file). Say what went wrong.
        if let (Err(e), true) = (&decoded, heeler_raw::is_gpr(&bytes)) {
            return Err(IoError::Unsupported(e.to_string()));
        }
        if let Ok(sensor) = decoded {
            let sensor_data = sensor.sensor_data;
            let mut img = sensor_to_imagebuf(sensor);
            if sensor_data {
                capture_sharpen_develop(&mut img, opts, 1.0);
            }
            // A develop the size of the file's thumbnail IS the thumbnail:
            // LibRaw, meeting a main image it has no decoder for, develops
            // the one IFD it can read, and a 160 by 120 strip then wears
            // the photograph's name with raw color treatment on top (the
            // pink Capitol Reef sky of 2026-09-20, a RAW editor's HDR DNG).
            if develop_is_the_picture(&img, &bytes) && reduced_copy_of(&img, &bytes).is_none() {
                return Ok(unbake(pixels.of(img, &bytes), &bytes));
            }
            if !develop_is_the_picture(&img, &bytes) {
                rejected = Some((img.width, img.height));
            }
        }
    }
    #[cfg(not(feature = "libraw"))]
    let _ = is_raw_extension(path);
    let out = match decode_bytes(&bytes) {
        // Phone JPEGs store pixels unrotated and describe the device's
        // attitude in EXIF; without this an inverted-landscape iPhone
        // shot developed upside down.
        Ok(img) => match (is_raw_extension(path), reduced_copy_of(&img, &bytes)) {
            // The image crate reads a TIFF's first IFD, which in a DNG is
            // the thumbnail too. The largest embedded JPEG preview stands
            // in when there is one; otherwise the file is refused in
            // words, since a thumbnail shown as the photograph is a
            // wrong picture and a wrong picture is worse than an error.
            (true, Some(full)) => {
                if pixels == Pixels::SceneLinear {
                    return Err(IoError::Unsupported(format!(
                        "scene-linear stack member needs its {} x {} sensor develop, not a rendered preview", full.0, full.1
                    )));
                }
                let preview = extract_raw_preview(&bytes)
                    .and_then(|p| decode_bytes(p).ok())
                    .filter(|p| reduced_copy_of(p, &bytes).is_none());
                match preview {
                    Some(p) => Ok(apply_orientation(p, raw_orientation(&bytes))),
                    None => Err(IoError::Unsupported(format!(
                        "the photograph in this file is {} x {} but only its {} x {} thumbnail could be read; its main image uses an encoding this build cannot decode",
                        full.0, full.1, img.width, img.height
                    ))),
                }
            }
            _ => Ok(apply_orientation(img, media_orientation(&bytes))),
        },
        Err(original) if memory::is_refusal(&original.to_string()) => Err(original),
        Err(original) if pixels == Pixels::SceneLinear && is_raw_extension(path) => Err(original),
        Err(original) => match extract_raw_preview(&bytes) {
            Some(preview) => {
                decode_bytes(preview).map(|img| apply_orientation(img, raw_orientation(&bytes)))
            }
            None => Err(original),
        },
    };
    match (out, rejected) {
        (Err(e), Some(size)) if !memory::is_refusal(&e.to_string()) => Err(rejected_develop(size)),
        (out, _) => out.map(|img| unbake(img, &bytes)),
    }
}

/// The photograph's real size when `img` is a reduced copy of it: a
/// decode with less than a quarter of the pixels the file's largest
/// frame declares is a thumbnail or preview IFD, not the picture. None
/// for a decode the size of the picture, or for a file that declares
/// nothing.
pub fn reduced_copy_of(img: &ImageBuf, bytes: &[u8]) -> Option<(u32, u32)> {
    let (w, h) = largest_frame(bytes)?;
    let full = w as u64 * h as u64;
    let got = img.width as u64 * img.height as u64;
    (got.saturating_mul(4) < full).then_some((w, h))
}

/// Puts back the headroom a baked DNG was scaled down to fit.
///
/// A merge holds highlights above scene white, and 16 unsigned bits do
/// not, so the bake divides the frame down and records what it divided by
/// as an exposure offset. This multiplies it back, which is the whole
/// difference between reopening a baked merge and getting the picture you
/// baked, or a darker one.
///
/// Only ever touches files this app wrote: `baked_exposure` returns None
/// for anything else, camera DNGs very much included.
fn unbake(mut img: ImageBuf, bytes: &[u8]) -> ImageBuf {
    let Some(stops) = bake::baked_exposure(bytes) else {
        return img;
    };
    if stops.abs() < 1e-4 {
        return img;
    }
    let gain = stops.exp2();
    for px in img.data.chunks_exact_mut(4) {
        px[0] *= gain;
        px[1] *= gain;
        px[2] *= gain;
    }
    img
}

/// Renders a sensor develop by the instructions its DNG carries: a
/// phone's baseline exposure, gain table map and tone curve
/// (src/dng_gain.rs). Only ever a develop of the file's own pixels:
/// the embedded preview a failed develop falls back to is the phone's
/// finished picture and has had all three already. Anything without a
/// gain table map passes through untouched.
fn as_the_file_renders(mut img: ImageBuf, bytes: &[u8]) -> ImageBuf {
    if let Some(rendering) = dng_gain::file_rendering(bytes) {
        dng_gain::render(&mut img, &rendering);
    }
    img
}

/// Applies an EXIF orientation (1..8) to decoded pixels. Embedded RAW
/// previews are stored unrotated with an orientation tag; without this,
/// portrait thumbnails display sideways.
pub fn apply_orientation(img: ImageBuf, orientation: u16) -> ImageBuf {
    if orientation <= 1 || orientation > 8 {
        return img;
    }
    let (w, h) = (img.width, img.height);
    let swaps = matches!(orientation, 5 | 6 | 7 | 8);
    let (ow, oh) = if swaps { (h, w) } else { (w, h) };
    let mut out = ImageBuf::new(ow, oh);
    for y in 0..h {
        for x in 0..w {
            let (nx, ny) = match orientation {
                2 => (w - 1 - x, y),             // mirror horizontal
                3 => (w - 1 - x, h - 1 - y),     // rotate 180
                4 => (x, h - 1 - y),             // mirror vertical
                5 => (y, x),                     // transpose
                6 => (h - 1 - y, x),             // rotate 90 CW
                7 => (h - 1 - y, w - 1 - x),     // transverse
                _ => (y, w - 1 - x),             // 8: rotate 90 CCW
            };
            out.set_pixel(nx, ny, img.pixel(x, y));
        }
    }
    out
}

/// Sanity check on a develop result: real photographs have strongly
/// correlated neighboring pixels; a decoder fed a compression format it
/// does not understand can "succeed" with pure noise (LibRaw 0.21 did
/// exactly that for Panasonic v7 files). Samples the center region; even
/// very high-ISO frames stay far under this threshold.
/// Whether a sensor develop is a picture rather than noise.
///
/// The gate every RAW decode above has to pass before it is displayed:
/// unsupported compression decodes into a mosaic that is technically an
/// image, and showing it is worse than showing the camera's preview. A
/// failure here is silent by design (the caller falls back), which is
/// exactly why the DNG verification probe reports it out loud.
pub fn develop_looks_sane(img: &ImageBuf) -> bool {
    if img.width < 8 || img.height < 8 {
        return true;
    }
    let (x0, y0) = (img.width / 4, img.height / 4);
    let (x1, y1) = (img.width * 3 / 4, img.height * 3 / 4);
    let mut diff = 0.0f64;
    let mut n = 0u64;
    let step = (((x1 - x0) * (y1 - y0)) / 20_000).max(1);
    let mut i = 0usize;
    for y in y0..y1 {
        for x in x0..x1 - 1 {
            i += 1;
            if i % step != 0 {
                continue;
            }
            diff += (img.pixel(x, y)[1] - img.pixel(x + 1, y)[1]).abs() as f64;
            n += 1;
        }
    }
    n == 0 || (diff / n as f64) < 0.15
}

/// Whether a develop LibRaw produced is the photograph: it passes
/// develop_looks_sane, or the file is Heeler's own bake. The noise test
/// is for a camera's compression LibRaw cannot read, which develops into
/// noise; a bake is a format Heeler writes and LibRaw reads, and a
/// picture that is itself mostly fine noise is still the picture. A max
/// stack of 432 night frames (2026-10-08) keeps every frame's
/// brightest noise, failed the test, and then had nothing to fall back
/// on: a bake carries no preview, and the image crate cannot read a
/// linear DNG, so the canvas sat on "unknown photometric
/// interpretation" and retried.
fn develop_is_the_picture(img: &ImageBuf, bytes: &[u8]) -> bool {
    bake::baked_exposure(bytes).is_some() || develop_looks_sane(img)
}

/// The answer when a develop was turned away as noise and nothing after
/// it could read the file either: that, rather than the last reader's
/// complaint (the image crate's TIFF reader on a linear DNG, which says
/// nothing about why the develop was not used).
fn rejected_develop(size: (usize, usize)) -> IoError {
    IoError::Unsupported(format!(
        "the RAW develop ({} x {}) read as noise rather than a photograph, and the file has no other picture this build can read",
        size.0, size.1
    ))
}

/// User-facing develop options for the RAW source node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawSourceOpts {
    pub camera_wb: bool,
    pub camera_matrix: bool,
    /// LibRaw highlight handling: 0 clip, 2 blend, 3..9 rebuild.
    pub highlight: i32,
    /// LibRaw demosaic (user_qual): -1 default, 0 linear, 11 DHT.
    pub demosaic: i32,
    /// Capture sharpening, 0..100 (the Source section's Sharpening):
    /// what every RAW develop owes the picture for the demosaic, the
    /// sensor's anti-aliasing filter and the lens, applied at the
    /// develop to sensor data only. 0 is the unsharpened develop.
    pub capture_sharpen: u8,
}

/// The Source section's Sharpening for a photograph nobody has touched
/// (2026-09-29, two reference RAW editors and Heeler side by side at 100 percent:
/// "Heeler is below any acceptable quality"). One reference editor sharpens every
/// RAW by default and the other harder. At 60 the S5 II canyon's sunlit face goes
/// from a fine-detail acutance of 0.208 (the unsharpened develop, an open-source
/// editor's unsharpened RCD reads 0.198) to 0.264, beside macOS's own RAW develop
/// at 0.254: measured by the desktop's quality probe (quality_probe.rs),
/// 2026-09-29.
pub const DEFAULT_CAPTURE_SHARPEN: u8 = 60;

impl Default for RawSourceOpts {
    fn default() -> Self {
        RawSourceOpts { camera_wb: true, camera_matrix: true, highlight: 0, demosaic: -1, capture_sharpen: DEFAULT_CAPTURE_SHARPEN }
    }
}

/// Capture sharpening at the develop. `scale` is this develop's pixels
/// per sensor pixel (1 at full size, 0.5 for the half-size preview
/// develop), so the radius means the same stretch of the photograph in
/// both and the preview shows what the export will.
#[cfg(feature = "libraw")]
fn capture_sharpen_develop(img: &mut ImageBuf, opts: RawSourceOpts, scale: f32) {
    if opts.capture_sharpen == 0 {
        return;
    }
    heeler_engine::capture_sharpen(img, opts.capture_sharpen as f32 / 100.0, heeler_engine::CAPTURE_SHARPEN_RADIUS * scale);
}

/// Preview-speed decode: RAW files demosaic at half size (~4x faster than
/// the export-quality path; previews are downscaled below that anyway),
/// falling back to the embedded JPEG preview, then standard decoders. A
/// develop that decodes into noise (unsupported compression) falls back
/// instead of being displayed.
pub fn decode_preview(path: &Path) -> Result<ImageBuf, IoError> {
    decode_preview_with(path, RawSourceOpts::default())
}

pub fn decode_preview_with(path: &Path, opts: RawSourceOpts) -> Result<ImageBuf, IoError> {
    at_boundary(path, || decode_preview_inner(path, opts, None, Pixels::AsTheFileRenders))
}

/// A preview tier asks the native decoder for reduced pixels before allocation.
/// Other platforms retain the portable decode path and its admission guard.
pub fn decode_preview_at(path: &Path, opts: RawSourceOpts, edge: usize) -> Result<ImageBuf, IoError> {
    preview_at(path, opts, edge, Pixels::AsTheFileRenders)
}

/// The preview tier of `decode_any_scene_linear`: a phone DNG's develop
/// without the file's rendering, for a stack's preview merge.
pub fn decode_preview_scene_linear_at(path: &Path, opts: RawSourceOpts, edge: usize) -> Result<ImageBuf, IoError> {
    preview_at(path, opts, edge, Pixels::SceneLinear)
}

fn preview_at(path: &Path, opts: RawSourceOpts, edge: usize, pixels: Pixels) -> Result<ImageBuf, IoError> {
    at_boundary(path, || {
        // Preserve the established RAW develop while it fits. The native
        // reduced image is the lower-memory escape path, not an export source.
        match memory::catch(|| decode_preview_inner(path, opts, Some(edge), pixels)).map_err(IoError::from).and_then(|v| v) {
            Ok(img) => Ok(img),
            Err(e) if memory::is_refusal(&e.to_string()) => {
                let bytes = read_image(path)?;
                // The reduced stand-ins below are the phone's finished
                // preview, which is no scene-linear frame: a merge that
                // asked for one is refused rather than handed it.
                if pixels == Pixels::SceneLinear && (bytes.starts_with(&[255, 216]) || is_raw_extension(path)) {
                    return Err(e);
                }
                // Never the system decoder for an OpenEXR: it reads the
                // file wrongly, and the reduced decode above already
                // asked for the least this preview can be.
                if exr_passes::is_exr(&bytes) {
                    return Err(e);
                }
                if let Some(preview) = extract_raw_preview(&bytes) {
                    if let Some(img) = heic::decode_thumbnail(preview, edge) {
                        memory::note_preview_reduction(format!("Preview uses a reduced embedded image because {e}: {}", path.display()));
                        return Ok(apply_orientation(img, raw_orientation(&bytes)));
                    }
                }
                match heic::decode_thumbnail(&bytes, edge) {
                    Some(img) => {
                        memory::note_preview_reduction(format!("Preview uses a reduced native decode because {e}: {}", path.display()));
                        Ok(img)
                    }
                    None => Err(e),
                }
            }
            Err(e) => Err(e),
        }
    })
}

fn decode_preview_inner(path: &Path, opts: RawSourceOpts, edge: Option<usize>, pixels: Pixels) -> Result<ImageBuf, IoError> {
    #[cfg(not(feature = "libraw"))]
    let _ = opts;
    let bytes = read_image(path)?;
    // A scene-linear render is previewed at the tier's size, reduced
    // while its blocks are read; the full planes belong to export.
    if exr_passes::is_exr(&bytes) {
        return exr_passes::decode_beauty_reduced(&bytes, edge.unwrap_or(PREVIEW_EDGE).max(1));
    }
    if heic::is_heif(&bytes) {
        if let Some(image) = heic::decode_heif(&bytes) { return Ok(image); }
    }
    if is_raw_extension(path) && is_jxl_dng(&bytes) {
        // No half-size shortcut on this path: JPEG XL tiles decode
        // whole. Falling back is allowed here, unlike at develop
        // quality, because a preview's job is to show something.
        match decode_jxl_dng(&bytes) {
            Ok(img) => return Ok(pixels.of(img, &bytes)),
            Err(e) if memory::is_refusal(&e.to_string()) => return Err(e),
            Err(e) if pixels == Pixels::SceneLinear => return Err(e),
            Err(_) => {}
        }
    }
    #[cfg(feature = "libraw")]
    if is_raw_extension(path) {
        let dev = heeler_raw::DevelopOpts {
            half_size: true,
            fixed_white: pixels == Pixels::SceneLinear,
            camera_wb: opts.camera_wb,
            camera_matrix: opts.camera_matrix,
            highlight: opts.highlight,
            demosaic: opts.demosaic,
        };
        let decoded = heeler_raw::decode_sensor_with(&bytes, dev);
        if let Err(heeler_raw::RawError::Memory(e)) = &decoded { return Err(e.clone().into()); }
        // A GPR has no embedded preview or readable strip to fall back on:
        // what follows would only misname the damage (a "JPEG SOF" or
        // "photometric" error for a cut file). Say what went wrong.
        if let (Err(e), true) = (&decoded, heeler_raw::is_gpr(&bytes)) {
            return Err(IoError::Unsupported(e.to_string()));
        }
        if let Ok(sensor) = decoded {
            let sensor_data = sensor.sensor_data;
            let mut img = sensor_to_imagebuf(sensor);
            // The half-size develop is one pixel per two sensor pixels,
            // so the same sharpening reaches half as far in its pixels.
            if sensor_data {
                capture_sharpen_develop(&mut img, opts, 0.5);
            }
            if develop_is_the_picture(&img, &bytes) && (sensor_data || reduced_copy_of(&img, &bytes).is_none()) {
                return Ok(unbake(pixels.of(img, &bytes), &bytes));
            }
        }
    }
    if is_raw_extension(path) && pixels == Pixels::AsTheFileRenders {
        if let Some(preview) = extract_raw_preview(&bytes) {
            if let Ok(img) = decode_bytes(preview) {
                return Ok(apply_orientation(img, raw_orientation(&bytes)));
            }
        }
    }
    // Average scene-linear samples after color ingestion. DCT scaling
    // averages encoded samples and darkens fine bright detail.
    if let (Pixels::SceneLinear, Some(edge)) = (pixels, edge) {
        if let Some(img) = decode_jpeg_with(&bytes, 0, Some(edge))? {
            return Ok(unbake(apply_orientation(img, media_orientation(&bytes)), &bytes));
        }
    }
    decode_bytes(&bytes).and_then(|img| {
        if pixels == Pixels::SceneLinear && is_raw_extension(path) && reduced_copy_of(&img, &bytes).is_some() {
            return Err(IoError::Unsupported("scene-linear stack member needs a sensor develop, not a thumbnail".into()));
        }
        Ok(unbake(apply_orientation(img, media_orientation(&bytes)), &bytes))
    })
}

/// A JPEG through turbo, with optional DCT reduction. A zero edge keeps
/// every input pixel. Scene-linear stacks use the full decode before
/// color conversion and area reduction.
fn decode_jpeg_reduced(bytes: &[u8], edge: usize) -> Result<Option<ImageBuf>, IoError> {
    decode_jpeg_with(bytes, edge, None)
}

fn decode_jpeg_with(bytes: &[u8], native_edge: usize, linear_edge: Option<usize>) -> Result<Option<ImageBuf>, IoError> {
    if !bytes.starts_with(&[255, 216]) {
        return Ok(None);
    }
    let Some((w, h, rgb)) = fast_jpeg::decode_reduced(bytes, native_edge)? else { return Ok(None) };
    let _job = Job::admit(memory::sum([rgb.len(), memory::bytes(w, h, 1, 32)?, bytes.len()])?, "JPEG color conversion")?;
    let profile = input_color::jpeg_profile(&mut Cursor::new(bytes));
    if let Some(edge) = linear_edge.filter(|edge| *edge > 0 && w.max(h) > *edge) {
        if matches!(profile, Ok(None)) && input_color::WORKING_SPACE.name == "linear-srgb"
            && media_orientation(bytes) == 1 && bake::baked_exposure(bytes).is_none() {
            // Read linear values as the area reducer needs them, avoiding
            // a full float image without changing its sums or admission.
            return Ok(Some(heeler_engine::downscale::downscale_rgb8_linear(&rgb, w, h, edge, jpeg_linear_values())));
        }
    }
    let mut out = ImageBuf::try_new(w, h)?;
    ingest_jpeg_rgb8(&mut out, &rgb, profile.as_ref().map(|p| p.as_deref()).map_err(|e| *e));
    Ok(Some(out))
}

fn jpeg_linear_values() -> &'static [f32; 256] {
    static LINEAR: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    LINEAR.get_or_init(|| std::array::from_fn(|v| srgb_to_linear(v as f32 / 255.0)))
}

fn ingest_jpeg_rgb8(out: &mut ImageBuf, rgb: &[u8], profile: Result<Option<&[u8]>, &str>) {
    if matches!(profile, Ok(None)) && input_color::WORKING_SPACE.name == "linear-srgb" {
        // JPEG samples have only 256 values. Keep their exact transfer
        // result instead of repeating a power function for every pixel.
        let linear = jpeg_linear_values();
        for (dest, px) in out.data.chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
            for c in 0..3 { dest[c] = linear[px[c] as usize]; }
            dest[3] = 1.0;
        }
        return;
    }
    for (dest, px) in out.data.chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
        for c in 0..3 {
            dest[c] = px[c] as f32 / 255.0;
        }
        dest[3] = 1.0;
    }
    input_color::ingest(out, profile);
}

/// Fast decode for thumbnails: prefers the RAW file's embedded JPEG
/// preview over a full sensor demosaic (orders of magnitude cheaper, and
/// visually identical at thumbnail sizes), then standard decoders, and
/// only demosaics as a last resort. Library browsing must never pay the
/// develop-quality price per file. Embedded previews are rotated to their
/// EXIF orientation, so portrait shots thumbnail as portraits.
pub fn decode_thumbnail(path: &Path) -> Result<ImageBuf, IoError> {
    at_boundary(path, || decode_thumbnail_inner(path))
}

/// The longer side a preview decode of a scene-linear file is held to
/// when no edge is asked for: the preview tier the desktop renders at.
pub const PREVIEW_EDGE: usize = 2048;
/// The longer side a thumbnail decode is held to, the size the system
/// decoder's thumbnails already use.
pub const THUMBNAIL_EDGE: usize = 1200;

fn decode_thumbnail_inner(path: &Path) -> Result<ImageBuf, IoError> {
    let bytes = read_image(path)?;
    // An OpenEXR has no embedded preview and the system decoder reads
    // it wrongly (premultiplied, re-linearized), so its thumbnail is
    // its own beauty, reduced while the blocks are read.
    if exr_passes::is_exr(&bytes) {
        return exr_passes::decode_beauty_reduced(&bytes, THUMBNAIL_EDGE);
    }
    if heic::is_heif(&bytes) {
        if let Some(image) = heic::decode_thumbnail(&bytes, 1200) { return Ok(image); }
    }
    if is_raw_extension(path) {
        if let Some(preview) = extract_raw_preview(&bytes) {
            if let Ok(img) = decode_bytes(preview) {
                return Ok(apply_orientation(img, raw_orientation(&bytes)));
            }
        }
        if is_jxl_dng(&bytes) {
            return decode_jxl_dng(&bytes).map(|img| unbake(as_the_file_renders(img, &bytes), &bytes));
        }
        // A GPR has no preview, and the TIFF reader below cannot read its
        // VC-5 tile: develop it at half size (plenty for a thumbnail), and
        // report a damaged one as itself.
        #[cfg(feature = "libraw")]
        if heeler_raw::is_gpr(&bytes) {
            return match heeler_raw::decode_sensor_half(&bytes) {
                Ok(sensor) => Ok(unbake(as_the_file_renders(sensor_to_imagebuf(sensor), &bytes), &bytes)),
                Err(heeler_raw::RawError::Memory(e)) => Err(e.into()),
                Err(e) => Err(IoError::Unsupported(e.to_string())),
            };
        }
    }
    match decode_bytes(&bytes) {
        Ok(img) => Ok(unbake(apply_orientation(img, media_orientation(&bytes)), &bytes)),
        Err(original) => {
            #[cfg(feature = "libraw")]
            if is_raw_extension(path) {
                if let Ok(sensor) = heeler_raw::decode_sensor(&bytes) {
                    return Ok(unbake(as_the_file_renders(sensor_to_imagebuf(sensor), &bytes), &bytes));
                }
            }
            Err(original)
        }
    }
}

#[derive(Default)]
struct Encoded(Vec<u8>);
impl std::io::Write for Encoded {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.try_reserve(bytes.len()).map_err(|_| std::io::Error::other("Not enough memory for encoded image"))?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
}

fn encode_capacity(buf: &ImageBuf, bytes_per_pixel: usize) -> Result<Vec<u8>, IoError> {
    let count = memory::bytes(buf.width, buf.height, 1, bytes_per_pixel)?;
    if buf.width > u32::MAX as usize || buf.height > u32::MAX as usize {
        return Err(MemoryError::Geometry("encoder dimensions".into()).into());
    }
    let mut v = memory::vector(count, 0u8, "encoder pixels")?;
    v.clear();
    Ok(v)
}

fn to_srgb_u8(buf: &ImageBuf, include_alpha: bool) -> Result<Vec<u8>, IoError> {
    let channels = if include_alpha { 4 } else { 3 };
    let mut out = encode_capacity(buf, channels)?;
    for px in 0..buf.width * buf.height {
        let i = px * 4;
        for c in 0..3 {
            out.push(srgb_u8(buf.data[i + c]));
        }
        if include_alpha {
            out.push((buf.data[i + 3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
        }
    }
    Ok(out)
}

/// Encodes to 8-bit sRGB PNG, preserving alpha. The sRGB profile rides
/// along (iCCP): untagged color is formally undefined, and "everyone
/// assumes sRGB" stops being true exactly where it matters, in print
/// pipelines and on wide-gamut displays.
pub fn encode_png(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    let data = to_srgb_u8(buf, true)?;
    let mut bytes = Encoded::default();
    let mut enc = PngEncoder::new(&mut bytes);
    enc.set_icc_profile(icc::srgb_profile().to_vec())
        .map_err(|e| IoError::Image(image::ImageError::Unsupported(e)))?;
    enc.write_image(&data, buf.width as u32, buf.height as u32, ExtendedColorType::Rgba8)?;
    Ok(bytes.0)
}

/// Encodes to 8-bit PNG with NO transfer conversion: the buffer's
/// values become the bytes directly.
///
/// The transform drag's live preview renders a layer's content node on
/// its own, and that node's pixels are already display-referred: the
/// art stack composites between to_display and to_scene. Running them
/// through encode_png's linear-to-sRGB would encode them a second time,
/// and a double-encoded midtone reads as the layer having brightened.
/// Untagged on purpose: the bytes are already in the display's space,
/// and a profile would only invite a second interpretation.
pub fn encode_png_raw(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    let mut data = encode_capacity(buf, 4)?;
    for px in 0..buf.width * buf.height {
        let i = px * 4;
        for c in 0..4 {
            data.push((buf.data[i + c].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
        }
    }
    let mut bytes = Encoded::default();
    let enc = PngEncoder::new(&mut bytes);
    enc.write_image(&data, buf.width as u32, buf.height as u32, ExtendedColorType::Rgba8)?;
    Ok(bytes.0)
}

/// Decodes a PNG with NO transfer conversion: samples become values
/// directly, the exact inverse of encode_png_raw / encode_png16_raw.
/// For data riding a PNG container (smart-mask and depth rasters),
/// where a linearizing decode would silently bend every stored value.
/// Bit-depth aware: a 16-bit source keeps its precision - a depth
/// plane read back at 8 bits banded every derivative taken of it.
pub fn decode_png_raw(bytes: &[u8]) -> Result<ImageBuf, IoError> {
    decode_samples(bytes, false)
}

/// One 8-bit plane as a grayscale PNG, bytes as they are. The
/// full-resolution matte's container: a 24 MP coverage plane is a byte
/// a pixel here, where encode_png_raw would carry four channels of it.
pub fn encode_png_gray8(data: &[u8], width: usize, height: usize) -> Result<Vec<u8>, IoError> {
    assert_eq!(data.len(), width * height, "one byte a pixel expected");
    let _job = Job::admit(memory::sum([data.len(), 64 * 1024])?, "mask encoding")?;
    let mut bytes = Encoded::default();
    let enc = PngEncoder::new(&mut bytes);
    enc.write_image(data, width as u32, height as u32, ExtendedColorType::L8)?;
    Ok(bytes.0)
}

/// encode_png_gray8's inverse: (width, height, one byte a pixel). A PNG
/// of any other layout is read down to its luminance.
pub fn decode_png_gray8(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), IoError> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)?;
    let (w, h) = (img.width() as usize, img.height() as usize);
    let _job = Job::admit(memory::bytes(w, h, 1, 1)?, "mask decoding")?;
    Ok((w, h, img.into_luma8().into_raw()))
}

/// encode_png_raw's 16-bit sibling: no transfer conversion, no
/// profile, 65536 levels. The depth plane's container - 8 bits banded
/// the key light's shading ("weird artifact bands
/// everywhere").
pub fn encode_png16_raw(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    let mut data = encode_capacity(buf, 8)?;
    for px in 0..buf.width * buf.height {
        let i = px * 4;
        for c in 0..4 {
            let v = (buf.data[i + c].clamp(0.0, 1.0) * 65535.0).round() as u16;
            data.extend_from_slice(&v.to_ne_bytes());
        }
    }
    let mut bytes = Encoded::default();
    let enc = PngEncoder::new(&mut bytes);
    enc.write_image(&data, buf.width as u32, buf.height as u32, ExtendedColorType::Rgba16)?;
    Ok(bytes.0)
}

/// Encodes to 16-bit sRGB PNG, preserving alpha, with the sRGB profile
/// embedded (iCCP). The archival half of the export panel: a 16-bit file
/// survives a second round of grading that an 8-bit one visibly does
/// not, and PNG is the 16-bit container everything reads. Samples go to
/// the encoder in native byte order, which is what the image crate
/// expects for 16-bit writes; it does the big-endian swap the PNG spec
/// calls for on the way out.
pub fn encode_png16(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    let mut data = encode_capacity(buf, 8)?;
    for px in 0..buf.width * buf.height {
        let i = px * 4;
        for c in 0..3 {
            let v = linear_to_srgb(buf.data[i + c]).clamp(0.0, 1.0);
            data.extend_from_slice(&((v * 65535.0).round() as u16).to_ne_bytes());
        }
        let a = (buf.data[i + 3].clamp(0.0, 1.0) * 65535.0).round() as u16;
        data.extend_from_slice(&a.to_ne_bytes());
    }
    let mut bytes = Encoded::default();
    let mut enc = PngEncoder::new(&mut bytes);
    enc.set_icc_profile(icc::srgb_profile().to_vec())
        .map_err(|e| IoError::Image(image::ImageError::Unsupported(e)))?;
    enc.write_image(&data, buf.width as u32, buf.height as u32, ExtendedColorType::Rgba16)?;
    Ok(bytes.0)
}

/// Encodes to lossy WebP (8-bit sRGB, alpha kept), quality 1 to 100.
/// Half the bytes of an equivalent JPEG for photographs, which is why
/// the media server serves it and the export panel offers it. No ICC
/// tag: libwebp's simple API has nowhere to put one, and untagged sRGB
/// is what every browser assumes of a WebP anyway.
pub fn encode_webp(buf: &ImageBuf, quality: u8) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    if buf.width == 0 || buf.height == 0 {
        return Err(IoError::UnsupportedFormat);
    }
    let mut data = encode_capacity(buf, 4)?;
    for px in 0..buf.width * buf.height {
        let i = px * 4;
        for c in 0..3 {
            data.push(srgb_u8(buf.data[i + c]));
        }
        data.push((buf.data[i + 3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8);
    }
    let enc = webp::Encoder::from_rgba(&data, buf.width as u32, buf.height as u32);
    let encoded = enc.encode(quality.clamp(1, 100) as f32);
    let mut bytes = memory::vector(encoded.len(), 0u8, "WebP encoded output")?;
    bytes.copy_from_slice(&encoded);
    Ok(bytes)
}

/// Encodes to 8-bit sRGB JPEG (no alpha), quality 1 to 100, with the
/// sRGB profile embedded (ICC APP2 segment).
pub fn encode_jpeg(buf: &ImageBuf, quality: u8) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    let data = to_srgb_u8(buf, false)?;
    let mut bytes = Encoded::default();
    let mut enc = JpegEncoder::new_with_quality(&mut bytes, quality.clamp(1, 100));
    enc.set_icc_profile(icc::srgb_profile().to_vec())
        .map_err(|e| IoError::Image(image::ImageError::Unsupported(e)))?;
    enc.write_image(&data, buf.width as u32, buf.height as u32, ExtendedColorType::Rgb8)?;
    Ok(bytes.0)
}

/// Sniffs a format from bytes; useful for import filtering.
pub fn detect_format(bytes: &[u8]) -> Option<ImageFormat> {
    image::guess_format(bytes).ok()
}

/// Full-frame pixel dimensions of a source file, upright: what the
/// photograph IS, before any proxy, preview tier or crop touches it.
/// Container headers first (authoritative for JPEG/PNG/TIFF, and no
/// pixel decode), the EXIF tags as the fallback that covers RAW; the
/// EXIF orientation swap makes a portrait read as a portrait, matching
/// every decode path, which applies the rotation to the pixels.
pub fn source_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if exr_passes::is_exr(bytes) {
        return exr_passes::dimensions(bytes);
    }
    let exif = exif::read_exif(bytes);
    let dims = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|r| r.into_dimensions().ok())
        .or(match (exif.width, exif.height) {
            (Some(w), Some(h)) => Some((w, h)),
            _ => None,
        })
        // An RW2 fails both: unreadable as an image (Panasonic's magic)
        // and no standard size tags. Its sensor crop borders are the
        // frame, accepted only when they describe a plausible one, since
        // those tag numbers mean nothing in particular elsewhere.
        .or_else(|| {
            let [top, left, bottom, right] = exif.sensor_borders?;
            let (w, h) = (right.checked_sub(left)?, bottom.checked_sub(top)?);
            ((256..30_000).contains(&w) && (256..30_000).contains(&h)).then_some((w, h))
        })?;
    Some(if matches!(exif.orientation, Some(5..=8)) { (dims.1, dims.0) } else { dims })
}

#[cfg(all(test, feature = "libraw"))]
mod capture_sharpen_tests;

#[cfg(test)]
mod float_tiff_tests {
    use super::*;

    /// Heeler's 32-bit float TIFF comes back as the numbers it wrote:
    /// linear samples take no transfer on the way in, above 1.0 included.
    #[test]
    fn a_float_tiff_round_trips_its_linear_samples() {
        let mut img = ImageBuf::new(3, 2);
        for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
            px.copy_from_slice(&[0.5, 0.25, 2.0 + i as f32, 1.0]);
        }
        let bytes = encode_tiff32f(&img, crate::FloatTiffOptions { include_alpha: false, dpi: None }).unwrap();
        let back = decode_bytes(&bytes).unwrap();
        for (i, px) in back.data.chunks_exact(4).enumerate() {
            let want = [0.5, 0.25, 2.0 + i as f32];
            for c in 0..3 {
                assert!((px[c] - want[c]).abs() < 1e-5, "px{i} ch{c}: {} vs {}", px[c], want[c]);
            }
        }
        let page = tiff_pages::decode_page(&bytes, 0).unwrap();
        assert!((page.pixel(1, 0)[2] - 3.0).abs() < 1e-5, "the page reader agrees: {:?}", page.pixel(1, 0));
    }
}

/// A small real image for cross-module tests (the exif round-trips
/// encode through the actual JPEG/PNG encoders).
#[cfg(test)]
pub(crate) fn tests_support_image() -> ImageBuf {
    let mut img = ImageBuf::filled(16, 8, [0.2, 0.4, 0.6, 1.0]);
    img.data[0] = 0.9;
    img
}

#[cfg(test)]
mod tests {
    /// A baked DNG whose picture is itself fine noise opens: the noise
    /// test is for a camera's unreadable compression, and a bake is
    /// Heeler's own file (2026-10-08: a max stack of 432 night
    /// frames, baked to DNG, would not open; "unknown photometric
    /// interpretation"). A DNG not of Heeler's making that develops into
    /// noise is still refused, now in words that say so.
    #[test]
    #[cfg(feature = "libraw")]
    fn a_bake_of_a_noisy_picture_opens_and_a_noisy_develop_says_why() {
        let dir = tempfile::tempdir().unwrap();
        let mut noise = ImageBuf::new(96, 64);
        let mut seed = 2643u32;
        for y in 0..64 {
            for x in 0..96 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let v = (seed >> 8) as f32 / (1u32 << 24) as f32;
                noise.set_pixel(x, y, [v, v, v, 1.0]);
            }
        }
        assert!(!develop_looks_sane(&noise), "the fixture fails the noise test, as the star stack did");
        let baked = dir.path().join("MAX_stars.dng");
        let bytes = encode_dng(&noise, None).unwrap();
        std::fs::write(&baked, &bytes).unwrap();
        let full = decode_any(&baked).expect("Heeler's own bake opens");
        assert_eq!((full.width, full.height), (96, 64));
        assert!(decode_preview_at(&baked, RawSourceOpts::default(), 64).is_ok(), "and its preview tier");
        // The same file with the bake's marker renamed is anyone's DNG.
        let mut theirs = bytes.clone();
        let at = theirs.windows(bake::BAKE_CAMERA_MODEL.len()).position(|w| w == bake::BAKE_CAMERA_MODEL.as_bytes()).unwrap();
        theirs[at] = b'N';
        let other = dir.path().join("someone_else.dng");
        std::fs::write(&other, &theirs).unwrap();
        let why = decode_any(&other).unwrap_err().to_string();
        assert!(why.contains("read as noise"), "{why}");
    }

    /// A GoPro GPR's estimate counts the rewritten copy LibRaw develops
    /// from, two bytes a pixel past the file: a stack lends each frame
    /// exactly its estimate, and a full-size GPR stack was refused for the
    /// difference (the 26.5.1 review).
    #[test]
    #[cfg(feature = "libraw")]
    fn a_gpr_estimate_counts_the_rewritten_copy() {
        let gpr = synthetic_gpr(64, 48, &[0x5a; 512]);
        let mut plain = gpr.clone();
        plain[10 + 12 * 3 + 8] = 1; // the fourth entry, Compression, set to 1: not a GPR
        assert!(heeler_raw::is_gpr(&gpr) && !heeler_raw::is_gpr(&plain));
        let g = estimate_from(&gpr, gpr.len(), true, false).unwrap().unwrap();
        assert_eq!((g.width, g.height), (64, 48));
        let base = memory::sum([memory::bytes(64, 48, 1, 32).unwrap(), gpr.len(), 64 << 10]).unwrap();
        assert_eq!(g.workspace, base + 64 * 48 * 2);
    }

    /// One IFD shaped like a GPR's: w by h, 16 bits, compression 9
    /// (VC-5), one tile, RGGB, with `tile` as its contents.
    #[cfg(feature = "libraw")]
    fn synthetic_gpr(w: u32, h: u32, tile: &[u8]) -> Vec<u8> {
        let tags: [(u16, u16, u32); 9] = [
            (256, 4, w), (257, 4, h), (258, 3, 16), (259, 3, 9), (322, 4, w), (323, 4, h),
            (324, 4, 0), (325, 4, tile.len() as u32), (33422, 1, 0),
        ];
        let tile_at = 8 + 2 + 12 * tags.len() as u32 + 4;
        let mut bytes = b"II*\0".to_vec();
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&(tags.len() as u16).to_le_bytes());
        for (id, kind, value) in tags {
            bytes.extend_from_slice(&id.to_le_bytes());
            bytes.extend_from_slice(&kind.to_le_bytes());
            bytes.extend_from_slice(&(if id == 33422 { 4u32 } else { 1 }).to_le_bytes());
            match (id, kind) {
                (324, _) => bytes.extend_from_slice(&tile_at.to_le_bytes()),
                (33422, _) => bytes.extend_from_slice(&[0, 1, 1, 2]),
                (_, 3) => bytes.extend_from_slice(&[value as u8, (value >> 8) as u8, 0, 0]),
                _ => bytes.extend_from_slice(&value.to_le_bytes()),
            }
        }
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(tile);
        bytes
    }

    /// A damaged GoPro GPR says it is a damaged GPR on every path. It has
    /// no preview to fall back on, and the readers after the develop
    /// misnamed the damage ("JPEG SOF ... 24 bits of precision" from the
    /// full decode, "unknown photometric interpretation" from the
    /// thumbnail, for a GPR cut short).
    #[test]
    #[cfg(feature = "libraw")]
    fn a_damaged_gpr_reports_itself_on_every_path() {
        let dir = tempfile::tempdir().unwrap();
        // A GPR's header over a tile that is no VC-5 stream.
        let bytes = synthetic_gpr(64, 48, &[0x5a; 512]);
        assert!(heeler_raw::is_gpr(&bytes));
        let path = dir.path().join("GOPR0001.GPR");
        std::fs::write(&path, &bytes).unwrap();
        for (what, result) in [
            ("decode_any", decode_any(&path)),
            ("preview", decode_preview_at(&path, RawSourceOpts::default(), 64)),
            ("thumbnail", decode_thumbnail(&path)),
        ] {
            let why = result.expect_err(what).to_string();
            assert!(why.contains("GoPro GPR"), "{what}: {why}");
        }
    }

    #[test]
    #[cfg(feature = "libraw")]
    fn review_scene_linear_white_is_independent_of_the_brightest_sample() {
        let dir = tempfile::tempdir().unwrap();
        let opts = RawSourceOpts {
            capture_sharpen: 0,
            ..Default::default()
        };
        let mut outputs = Vec::new();
        for top in [0.82, 1.0] {
            let mut frame = ImageBuf::filled(64, 32, [0.2, 0.2, 0.2, 1.0]);
            for y in 0..8 {
                for x in 0..8 {
                    frame.set_pixel(x, y, [top, top, top, 1.0]);
                }
            }
            let path = dir.path().join(format!("white-{top}.dng"));
            std::fs::write(&path, encode_dng(&frame, None).unwrap()).unwrap();
            let full = decode_any_scene_linear(&path, opts).unwrap();
            let preview = decode_preview_scene_linear_at(&path, opts, 32).unwrap();
            eprintln!(
                "WHITEINDEPENDENCE top={top} full={:?} preview={:?}",
                full.pixel(32, 16),
                preview.pixel(preview.width / 2, preview.height / 2)
            );
            for img in [&full, &preview] {
                for c in 0..3 {
                    assert!((img.pixel(img.width / 2, img.height / 2)[c] - 0.2).abs() < 0.001);
                }
            }
            outputs.push(full.pixel(32, 16));
        }
        assert_eq!(outputs[0], outputs[1]);
    }

    #[test]
    #[cfg(feature = "libraw")]
    fn review_linear_dng_levels_define_black_and_white_before_stacking() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("levels.dng");
        let source = encode_dng(&ImageBuf::filled(64, 32, [0.5, 0.5, 0.5, 1.0]), None).unwrap();
        let opts = RawSourceOpts {
            capture_sharpen: 0,
            ..Default::default()
        };
        for (black, white, want) in [
            (0u32, 65535u32, 0.5f32),
            (0, 32767, 1.0),
            (0, 131070, 0.5),
            (16384, 65535, 1.0 / 3.0),
            (49151, 65535, 0.0),
        ] {
            let mut bytes = source.clone();
            let at = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
            let count = u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize;
            for k in 0..count {
                let i = at + 2 + k * 12;
                let tag = u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap());
                if tag == 50714 || tag == 50717 {
                    bytes[i + 8..i + 12]
                        .copy_from_slice(&(if tag == 50714 { black } else { white }).to_le_bytes());
                }
            }
            std::fs::write(&path, bytes).unwrap();
            let got = decode_any_scene_linear(&path, opts).unwrap().pixel(32, 16);
            // The stored sample is half scale. White at half scale clips
            // it; black at .25 gives (.5-.25)/(.75), and black at .75 clips
            // it to zero. LibRaw caps a white above 16-bit storage to 65535:
            // that synthetic tag does not turn this sample into .25.
            for c in 0..3 {
                assert!(
                    (got[c] - want).abs() < 0.001,
                    "black={black} white={white}: {got:?}"
                );
            }
            eprintln!("DNGLEVEL black={black} white={white} expected={want} got={got:?}");
        }
    }

    #[test]
    fn review_scene_linear_raw_does_not_fall_back_to_a_rendered_preview() {
        let dir=tempfile::tempdir().unwrap();
        let path=dir.path().join("unsupported.dng");
        let mut image=ImageBuf::new(64,48);
        for y in 0..48 {for x in 0..64 {image.set_pixel(x,y,[(x%7) as f32/7.0,(y%5) as f32/5.0,((x+y)%11) as f32/11.0,1.0]);}}
        let jpeg=encode_jpeg(&image,95).unwrap(); assert!(jpeg.len()>1024);
        let mut container=vec![0xAB;9000]; container.extend_from_slice(&jpeg);
        std::fs::write(&path,container).unwrap();
        // Viewing can use the finished embedded JPEG. A sensor-light merge
        // must report the failed develop instead of silently weighting it.
        assert!(decode_any(&path).is_ok());
        assert!(decode_preview_at(&path,RawSourceOpts::default(),32).is_ok());
        assert!(decode_any_scene_linear(&path,RawSourceOpts::default()).is_err());
        assert!(decode_preview_scene_linear_at(&path,RawSourceOpts::default(),32).is_err());
    }

    #[test]
    fn review_scene_linear_preview_refuses_a_thumbnail_ifd() {
        let dir=tempfile::tempdir().unwrap(); let path=dir.path().join("unsupported.dng");
        std::fs::write(&path,thumbnail_first_dng((4000,3000))).unwrap();
        assert!(decode_preview_scene_linear_at(&path,RawSourceOpts::default(),2048).is_err());
    }

    /// The catalog decides what a folder scan shows and this crate decides
    /// what develops; a raw extension on one list and not the other is a
    /// camera the app silently cannot see.
    #[test]
    fn every_raw_extension_is_indexed_by_the_catalog() {
        for ext in super::RAW_EXTENSIONS {
            assert!(
                heeler_catalog::SUPPORTED_EXTENSIONS.contains(ext),
                "{ext} develops through LibRaw but the catalog never lists it"
            );
        }
    }

    use super::*;

    /// A DNG-shaped file: a 160 by 120 RGB thumbnail in the first IFD
    /// and, in a SubIFD, the photograph at `full` pixels in an encoding
    /// nothing here reads (deflate-compressed float, tag 8, with junk
    /// for pixels), the way one RAW editor's HDR merge arrives. Little
    /// endian, entries in tag order, arrays out of line.
    fn thumbnail_first_dng(full: (u32, u32)) -> Vec<u8> {
        fn entry(out: &mut Vec<u8>, tag: u16, kind: u16, count: u32, value: u32) {
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(&count.to_le_bytes());
            out.extend_from_slice(&value.to_le_bytes());
        }
        let (tw, th) = (160u32, 120u32);
        let thumb: Vec<u8> = (0..tw * th).flat_map(|i| [(i % 251) as u8, 200u8, 90u8]).collect();
        let junk = vec![0x5au8; 4096];
        // Layout: header, IFD0 (10 entries), IFD1 (11 entries), then the
        // out-of-line arrays and the two pixel blobs.
        let ifd0_at = 8usize;
        let ifd0_len = 2 + 10 * 12 + 4;
        let ifd1_at = ifd0_at + ifd0_len;
        let ifd1_len = 2 + 11 * 12 + 4;
        let arrays_at = ifd1_at + ifd1_len;
        let bits8_at = arrays_at; // 3 shorts: 8,8,8
        let bits16_at = bits8_at + 6; // 3 shorts: 16,16,16
        let fmt_at = bits16_at + 6; // 3 shorts: 3,3,3
        let dng_version_at = fmt_at + 6; // 4 bytes
        let thumb_at = dng_version_at + 4;
        let junk_at = thumb_at + thumb.len();
        let mut out = Vec::new();
        out.extend_from_slice(b"II");
        out.extend_from_slice(&42u16.to_le_bytes());
        out.extend_from_slice(&(ifd0_at as u32).to_le_bytes());
        // IFD0: the thumbnail, marked reduced, naming the SubIFD.
        out.extend_from_slice(&10u16.to_le_bytes());
        entry(&mut out, 254, 4, 1, 1);
        entry(&mut out, 256, 4, 1, tw);
        entry(&mut out, 257, 4, 1, th);
        entry(&mut out, 258, 3, 3, bits8_at as u32);
        entry(&mut out, 259, 3, 1, 1);
        entry(&mut out, 262, 3, 1, 2);
        entry(&mut out, 273, 4, 1, thumb_at as u32);
        entry(&mut out, 277, 3, 1, 3);
        entry(&mut out, 279, 4, 1, thumb.len() as u32);
        entry(&mut out, 330, 4, 1, ifd1_at as u32);
        out.extend_from_slice(&0u32.to_le_bytes());
        // IFD1: the photograph, LinearRaw, float, deflate, unreadable.
        out.extend_from_slice(&11u16.to_le_bytes());
        entry(&mut out, 254, 4, 1, 0);
        entry(&mut out, 256, 4, 1, full.0);
        entry(&mut out, 257, 4, 1, full.1);
        entry(&mut out, 258, 3, 3, bits16_at as u32);
        entry(&mut out, 259, 3, 1, 8);
        entry(&mut out, 262, 3, 1, 34892);
        entry(&mut out, 273, 4, 1, junk_at as u32);
        entry(&mut out, 277, 3, 1, 3);
        entry(&mut out, 278, 4, 1, full.1);
        entry(&mut out, 279, 4, 1, junk.len() as u32);
        entry(&mut out, 339, 3, 3, fmt_at as u32);
        out.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(out.len(), arrays_at);
        for v in [8u16, 8, 8, 16, 16, 16, 3, 3, 3] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&[1, 4, 0, 0]);
        assert_eq!(out.len(), thumb_at);
        out.extend_from_slice(&thumb);
        out.extend_from_slice(&junk);
        out
    }

    /// A DNG whose photograph no decoder here can read must not put its
    /// thumbnail on screen as the photograph: the largest frame the file
    /// declares is the picture's size, a decode a fraction of it is a
    /// reduced copy, and with no embedded preview to stand in the file
    /// is refused in words that name both sizes.
    #[test]
    fn a_dng_whose_main_image_cannot_be_read_is_refused_not_shown_as_its_thumbnail() {
        let bytes = thumbnail_first_dng((4000, 3000));
        assert_eq!(largest_frame(&bytes), Some((4000, 3000)), "the SubIFD's size, not the first IFD's");
        let thumb = decode_bytes(&bytes).expect("the image crate reads the first IFD");
        assert_eq!((thumb.width, thumb.height), (160, 120));
        assert_eq!(reduced_copy_of(&thumb, &bytes), Some((4000, 3000)));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("merge_HDR.dng");
        std::fs::write(&path, &bytes).unwrap();
        match decode_any(&path) {
            Ok(img) => panic!("a {} x {} thumbnail was shown as the photograph", img.width, img.height),
            Err(e) => {
                let words = e.to_string();
                assert!(words.contains("4000 x 3000") && words.contains("160 x 120"), "{words}");
            }
        }
        // A file whose first IFD IS the photograph is not a reduced copy.
        let whole = encode_tiff16(&tests_support_image()).unwrap();
        assert_eq!(largest_frame(&whole), Some((16, 8)));
        assert_eq!(reduced_copy_of(&decode_bytes(&whole).unwrap(), &whole), None);
        // Nor is a DNG this app baked, whose only IFD is the picture.
        let baked = encode_dng(&tests_support_image(), None).unwrap();
        assert_eq!(largest_frame(&baked), Some((16, 8)));
    }

    const EPS: f32 = 1e-4;

    /// Every decode failure names the file it was about.
    ///
    /// On `io error: No such file or directory (os error 2)` in the
    /// console: "What file? I don't know where to look to even
    /// understand how to fix this. It should show me the expected file
    /// path." Everything above this crate has thrown the path away by
    /// then, so it has to be added here or nowhere.
    #[test]
    fn decode_refusal_names_the_file_and_releases_its_reservation() {
        // The thread name carries "::", which Windows refuses in a file name.
        let thread = std::thread::current().name().unwrap_or("decode").replace("::", "-");
        let path = std::env::temp_dir().join(format!("heeler-memory-{}-{}.png", std::process::id(), thread));
        let pixels = ImageBuf::filled(16, 16, [0.2, 0.4, 0.6, 1.0]);
        std::fs::write(&path, encode_png(&pixels).unwrap()).unwrap();
        memory::with_budget(4096, || {
            let before = memory::budget().available();
            let error = decode_file(&path).unwrap_err().to_string();
            assert!(error.contains("Not enough memory"), "{error}");
            assert!(error.contains(path.to_str().unwrap()));
            assert_eq!(memory::budget().available(), before);
        });
        // Temporary test fixture only, never a photograph.
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_tiffs_alpha_survives_decode_into_the_fourth_sample() {
        // 26.3 Phase 6, step 1: evidence before change. A TIFF's fourth
        // sample must land in ImageBuf.data[..][3] through the whole
        // decode_any path, ingest included.
        let mut img = ImageBuf::filled(4, 2, [0.2, 0.4, 0.6, 1.0]);
        img.data[3] = 0.25;
        img.data[7] = 0.75;
        let bytes = bake::encode_tiff16(&img).unwrap();
        let path = std::env::temp_dir().join(format!("heeler-alpha-{}.tif", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let back = decode_any(&path).unwrap();
        // Temporary test fixture only, never a photograph.
        std::fs::remove_file(&path).unwrap();
        assert!((back.data[3] - 0.25).abs() < 0.01, "alpha 0.25: {}", back.data[3]);
        assert!((back.data[7] - 0.75).abs() < 0.01, "alpha 0.75: {}", back.data[7]);
        // And the color still ingests: the red channel moved through the
        // sRGB round trip rather than passing the linear number through.
        assert!((back.data[0] - 0.2).abs() < 0.01, "red: {}", back.data[0]);
    }

    #[test]
    fn a_scene_linear_jpeg_refuses_an_encoded_space_memory_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stripes.jpg");
        let mut src = ImageBuf::new(256, 128);
        for y in 0..128 { for x in 0..256 { let v = (x % 2) as f32; src.set_pixel(x, y, [v, v, v, 1.0]); } }
        std::fs::write(&path, encode_jpeg(&src, 100).unwrap()).unwrap();
        let result = memory::with_budget(700 << 10, || decode_preview_scene_linear_at(&path, RawSourceOpts::default(), 64));
        assert!(result.is_err(), "a native reduced JPEG averages encoded values");
        assert!(memory::is_refusal(&result.unwrap_err().to_string()));
    }

    #[test]
    fn scene_linear_jpeg_preview_is_bit_exact_with_full_decode_then_area() {
        let dir = tempfile::tempdir().unwrap();
        let mut inputs = Vec::new();
        for (w, h) in [(57, 31), (65, 1), (1, 67), (64, 32)] {
            let rgb: Vec<u8> = (0..w * h * 3).map(|i| ((i * 73 + i / 7) % 256) as u8).collect();
            let mut bytes = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95)
                .encode(&rgb, w, h, image::ExtendedColorType::Rgb8).unwrap();
            assert!(input_color::jpeg_profile(&mut Cursor::new(&bytes)).unwrap().is_none());
            inputs.push(bytes);
        }
        let payload = b"ICC_PROFILE\0\x01\x01not a profile";
        let mut malformed = vec![255, 216, 255, 226];
        malformed.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        malformed.extend_from_slice(payload);
        malformed.extend_from_slice(&inputs[0][2..]);
        inputs.push(malformed);
        inputs.push(encode_jpeg(&ImageBuf::filled(57, 31, [0.2, 0.4, 0.6, 1.0]), 95).unwrap());
        for name in ["stack-progressive.jpg", "stack-gray.jpg", "stack-cmyk.jpg"] {
            inputs.push(std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name)).unwrap());
        }
        for orientation in 2..=8 {
            inputs.push(std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/stack-orientation-{orientation}.jpg"))).unwrap());
        }
        for (i, bytes) in inputs.iter().enumerate() {
            let path = dir.path().join(format!("area-{i}.jpg"));
            std::fs::write(&path, bytes).unwrap();
            let full = decode_any_scene_linear(&path, RawSourceOpts::default()).unwrap();
            for edge in [0, 1, 7, 16, 128] {
                let want = heeler_engine::downscale::downscale_area(&full, edge);
                let decoded = decode_preview_scene_linear_at(&path, RawSourceOpts::default(), edge).unwrap();
                let got = heeler_engine::downscale::downscale_area(&decoded, edge);
                assert_eq!((got.width, got.height), (want.width, want.height), "input {i}, edge {edge}");
                for (a, b) in got.data.iter().zip(&want.data) {
                    assert_eq!(a.to_bits(), b.to_bits(), "input {i}, edge {edge}");
                }
            }
        }
    }

    #[test]
    #[ignore = "set HEELER_JPEG to a read-only footage member for decoder stage timing"]
    fn a_real_jpeg_reports_native_color_and_area_cost() {
        let path = std::env::var("HEELER_JPEG").expect("set HEELER_JPEG");
        let bytes = std::fs::read(path).unwrap();
        for _ in 0..5 {
            let start = std::time::Instant::now();
            let (w, h, rgb) = fast_jpeg::decode_reduced(&bytes, 0).unwrap().unwrap();
            let native = start.elapsed();
            let start = std::time::Instant::now();
            let mut full = ImageBuf::new(w, h);
            let profile = input_color::jpeg_profile(&mut Cursor::new(&bytes));
            ingest_jpeg_rgb8(&mut full, &rgb, profile.as_ref().map(|p| p.as_deref()).map_err(|e| *e));
            let color = start.elapsed();
            let start = std::time::Instant::now();
            let reduced = heeler_engine::downscale::downscale_area(&full, 2048);
            eprintln!("JPEG stages native={:.4}s color={:.4}s area={:.4}s, {}x{}", native.as_secs_f64(), color.as_secs_f64(), start.elapsed().as_secs_f64(), reduced.width, reduced.height);
        }
    }

    #[test]
    fn native_jpeg_rgb8_color_is_bit_exact_for_every_sample_and_profile_path() {
        let rgb: Vec<u8> = (0..256).flat_map(|v| [v as u8, (255 - v) as u8, (v * 73 % 256) as u8]).collect();
        for profile in [Ok(None), Ok(Some(srgb_profile())), Err("test malformed JPEG profile")] {
            let mut want = ImageBuf::new(256, 1);
            for (dest, px) in want.data.chunks_exact_mut(4).zip(rgb.chunks_exact(3)) {
                for c in 0..3 { dest[c] = px[c] as f32 / 255.0; }
                dest[3] = 1.0;
            }
            input_color::ingest(&mut want, profile);
            let mut got = ImageBuf::new(256, 1);
            ingest_jpeg_rgb8(&mut got, &rgb, profile);
            for (got, want) in got.data.iter().zip(&want.data) {
                assert_eq!(got.to_bits(), want.to_bits());
            }
            assert!(got.data.chunks_exact(4).all(|p| p[3] == 1.0));
        }
    }

    #[test]
    fn reduced_jpeg_color_conversion_is_admitted_before_its_float_frame() {
        let jpeg = encode_jpeg(&ImageBuf::filled(256, 128, [0.2, 0.4, 0.6, 1.0]), 95).unwrap();
        let result = memory::with_budget(1 << 20, || memory::catch(|| {
            let _job = Job::admit(0, "test preview").unwrap();
            decode_jpeg_reduced(&jpeg, 64)
        }));
        let image = result.unwrap().unwrap().unwrap();
        assert_eq!((image.width, image.height), (64, 32));
    }

    #[test]
    fn decoder_limits_include_the_outer_jobs_reserved_memory() {
        let encoded = encode_png(&ImageBuf::new(16, 16)).unwrap();
        memory::with_budget(16_000, || {
            let _job = Job::admit(15_500, "whole export").unwrap();
            let img = decode_bytes(&encoded).unwrap();
            assert_eq!((img.width, img.height), (16, 16));
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_preview_fallback_reduces_before_allocation_and_names_the_reason() {
        let path = std::env::temp_dir().join(format!("heeler-native-memory-{}.png", std::process::id()));
        std::fs::write(&path, encode_png(&ImageBuf::filled(64, 64, [0.2, 0.4, 0.6, 1.0])).unwrap()).unwrap();
        memory::with_budget(100_000, || {
            let _ = memory::take_preview_notice();
            let img = decode_preview_at(&path, RawSourceOpts::default(), 4).unwrap();
            assert_eq!((img.width, img.height), (4, 4));
            let notice = memory::take_preview_notice().unwrap();
            assert!(notice.contains("reduced native decode"));
            assert!(notice.contains(path.to_str().unwrap()));
            assert!(memory::take_preview_notice().is_none());
        });
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn recipe_preview_estimates_retained_tier_pixels_and_one_native_workspace() {
        let estimate = DecodeEstimate { width: 6000, height: 4000, retained: 384_000_000, workspace: 768_000_000, encoded: 1000 };
        let (large, _) = estimate.preview(2048).unwrap();
        let (small, workspace) = estimate.preview(1024).unwrap();
        assert!(large > small * 3);
        assert!(small < estimate.retained / 20);
        assert_eq!(workspace, estimate.retained + small + 2000);
    }

    #[test]
    fn integer_and_float_samples_keep_their_values_and_alpha() {
        let pixels = ImageBuf::filled(3, 2, [0.1, 0.4, 0.9, 0.3]);
        let decoded = decode_png_raw(&encode_png16_raw(&pixels).unwrap()).unwrap();
        for (a, b) in pixels.data.iter().zip(decoded.data.iter()) { assert!((a - b).abs() < 0.00002); }
    }

    #[test]
    fn a_decode_failure_says_which_file() {
        let missing = std::path::Path::new("/nowhere/at/all/DSC_04871.NEF");
        for e in [
            decode_file(missing).unwrap_err(),
            decode_any(missing).unwrap_err(),
            decode_preview(missing).unwrap_err(),
            decode_thumbnail(missing).unwrap_err(),
        ] {
            let msg = e.to_string();
            assert!(msg.contains("/nowhere/at/all/DSC_04871.NEF"), "{msg}");
            // The reason survives beside the path: the app's own
            // "has it moved?" check reads these words.
            assert!(msg.to_lowercase().contains("no such file"), "{msg}");
            // And the path is last, so a caller can append the whole
            // thing to a sentence and it still reads as one.
            assert!(msg.ends_with("/nowhere/at/all/DSC_04871.NEF"), "{msg}");
        }
    }

    /// A file that exists and is not an image fails the same way. The
    /// unnamed "unsupported or unrecognized image format" was the same
    /// complaint waiting to be filed a second time.
    #[test]
    fn a_format_failure_says_which_file_too() {
        let dir = std::env::temp_dir().join("heeler-io-not-an-image");
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("notes.txt");
        std::fs::write(&f, b"this is not a photograph").unwrap();
        let msg = decode_any(&f).unwrap_err().to_string();
        assert!(msg.contains("notes.txt"), "{msg}");
        std::fs::remove_file(&f).ok();
    }

    /// Naming it twice would read as a stutter, so it does not.
    #[test]
    fn a_path_is_named_once_however_many_layers_it_crosses() {
        let p = std::path::Path::new("/nowhere/DSC.NEF");
        let once = naming(p, IoError::UnsupportedFormat);
        let twice = naming(p, once);
        assert_eq!(twice.to_string().matches("/nowhere/DSC.NEF").count(), 1);
    }

    /// ICC finding 's other half: whatever the graph delivers, the encode
    /// conversion itself must fail safe. Above-white clamps to 255,
    /// below-black to 0, and neither wraps, NaNs, or panics: the ceiling
    /// is a wall, not an overflow.
    #[test]
    fn encode_conversion_clamps_out_of_range_data_safely() {
        let mut img = ImageBuf::new(3, 1);
        img.set_pixel(0, 0, [4.0, 2.0, 1.5, 1.0]);
        img.set_pixel(1, 0, [-0.5, -0.01, 0.0, 1.0]);
        img.set_pixel(2, 0, [f32::NAN, 0.5, 0.5, 1.0]);
        let out = to_srgb_u8(&img, false).unwrap();
        assert_eq!(&out[0..3], &[255, 255, 255]);
        assert_eq!(&out[3..6], &[0, 0, 0]);
        // NaN lands somewhere in range rather than tearing the encode.
        assert!(out.len() == 9);
    }

    /// WP35's documented CMM failure mode: sRGB-class curves breaking
    /// continuity or monotonicity exactly at the linear-to-power segment
    /// boundary. Heeler hand-codes this curve here, in the engine, and
    /// in the GPU shader; this pins the io copy at its junctions.
    #[test]
    fn srgb_transfer_is_continuous_and_monotone_at_the_segment_boundary() {
        // Continuity across each junction: the two segment formulas must
        // agree to float noise where they meet.
        let e = 1e-6f32;
        assert!((srgb_to_linear(0.04045 - e) - srgb_to_linear(0.04045 + e)).abs() < 1e-5);
        assert!((linear_to_srgb(0.0031308 - e * e) - linear_to_srgb(0.0031308 + e * e)).abs() < 1e-5);
        // Monotone through a dense sweep concentrated near the junctions.
        let mut prev = -1.0f32;
        for i in 0..=10_000 {
            let x = i as f32 / 10_000.0 * 0.1; // the bottom tenth, where the seam lives
            let y = srgb_to_linear(x);
            assert!(y >= prev, "decode dipped at {x}");
            prev = y;
        }
        let mut prev = -1.0f32;
        for i in 0..=10_000 {
            let x = i as f32 / 10_000.0 * 0.01;
            let y = linear_to_srgb(x);
            assert!(y >= prev, "encode dipped at {x}");
            prev = y;
        }
    }

    /// A node rendered on its own is already display-referred, so the
    /// raw encoder must not touch the values: 0.5 in the buffer is byte
    /// 128, where encode_png would hand back 188 and the layer would
    /// preview brighter than the engine's own composite.
    #[test]
    fn raw_png_keeps_the_buffer_values() {
        // Decoded with the image crate directly: decode_bytes would
        // apply its own sRGB-to-linear and mask the difference under
        // test.
        let buf = ImageBuf::filled(2, 2, [0.5, 0.25, 0.75, 0.5]);
        let raw = image::load_from_memory(&encode_png_raw(&buf).unwrap())
            .unwrap()
            .to_rgba8();
        let px = raw.get_pixel(0, 0).0;
        assert!((px[0] as i32 - 128).abs() <= 1, "red got {}", px[0]);
        assert!((px[3] as i32 - 128).abs() <= 1, "alpha got {}", px[3]);
        // The tagged encoder is the one that moves the value.
        let tagged = image::load_from_memory(&encode_png(&buf).unwrap())
            .unwrap()
            .to_rgba8();
        let tpx = tagged.get_pixel(0, 0).0;
        assert!(tpx[0] > 180, "encode_png should gamma-encode 0.5, got {}", tpx[0]);
    }

    /// The whole point of tagging: a color-managed reader must find the
    /// exact profile bytes we embedded, in both formats.
    #[test]
    fn exports_carry_the_srgb_profile() {
        use image::ImageDecoder;
        let buf = {
            let mut b = ImageBuf::filled(4, 4, [0.2, 0.4, 0.6, 1.0]);
            b.data[0] = 0.9;
            b
        };
        let png = encode_png(&buf).unwrap();
        let mut dec = image::codecs::png::PngDecoder::new(Cursor::new(&png)).unwrap();
        assert_eq!(
            dec.icc_profile().unwrap().as_deref(),
            Some(icc::srgb_profile()),
            "PNG iCCP round-trips the profile"
        );
        let jpg = encode_jpeg(&buf, 90).unwrap();
        let mut dec = image::codecs::jpeg::JpegDecoder::new(Cursor::new(&jpg)).unwrap();
        assert_eq!(
            dec.icc_profile().unwrap().as_deref(),
            Some(icc::srgb_profile()),
            "JPEG APP2 round-trips the profile"
        );
    }

    #[test]
    fn srgb_transfer_matches_reference_values() {
        assert!((srgb_to_linear(0.0) - 0.0).abs() < EPS);
        assert!((srgb_to_linear(1.0) - 1.0).abs() < EPS);
        assert!((srgb_to_linear(0.5) - 0.21404114).abs() < EPS);
        assert!((linear_to_srgb(0.21404114) - 0.5).abs() < EPS);
    }

    /// WebP round-trips through the image crate's decoder: right
    /// dimensions, alpha kept, and visibly the same picture (lossy, so
    /// close rather than equal).
    #[test]
    fn webp_encodes_and_reads_back() {
        let img = ImageBuf::filled(8, 6, [0.5, 0.25, 0.1, 1.0]);
        let bytes = encode_webp(&img, 90).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        let back = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!((back.width(), back.height()), (8, 6));
        let px = back.get_pixel(4, 3);
        let want = (linear_to_srgb(0.5) * 255.0 + 0.5) as i32;
        assert!((px[0] as i32 - want).abs() < 8, "lossy but recognizably the same: {} vs {want}", px[0]);
        assert_eq!(px[3], 255);
    }

    /// The 16-bit PNG is sixteen bits where it counts: a value between
    /// two 8-bit steps survives, and the profile rides along exactly as
    /// it does in the 8-bit file.
    #[test]
    fn png16_is_actually_sixteen_bits_and_tagged() {
        use image::ImageDecoder;
        let img = ImageBuf::filled(4, 2, [0.25, 0.501, 0.75, 1.0]);
        let bytes = encode_png16(&img).unwrap();

        let mut dec = image::codecs::png::PngDecoder::new(Cursor::new(&bytes)).unwrap();
        assert_eq!(
            dec.icc_profile().unwrap().as_deref(),
            Some(icc::srgb_profile()),
            "PNG16 iCCP round-trips the profile"
        );
        let decoded = image::load_from_memory(&bytes).unwrap().to_rgba16();
        let g = decoded.get_pixel(0, 0)[1];
        let want = (linear_to_srgb(0.501) * 65535.0).round() as u16;
        assert_eq!(g, want);
        let g8 = (linear_to_srgb(0.501) * 255.0 + 0.5) as u8;
        assert_ne!(g, (g8 as u16) * 257, "the 8-bit answer would be {g8}");
    }

    #[test]
    fn srgb_round_trip_is_identity() {
        for i in 0..=100 {
            let v = i as f32 / 100.0;
            assert!((linear_to_srgb(srgb_to_linear(v)) - v).abs() < EPS);
        }
    }

    fn gradient(w: usize, h: usize) -> ImageBuf {
        let mut buf = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = srgb_to_linear(x as f32 / (w - 1) as f32);
                buf.set_pixel(x, y, [v, v * 0.5, 1.0 - v, 1.0]);
            }
        }
        buf
    }

    #[test]
    fn orientation_rotations_map_pixels_correctly() {
        // 2x1 image: red then green.
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [1.0, 0.0, 0.0, 1.0]);
        img.set_pixel(1, 0, [0.0, 1.0, 0.0, 1.0]);

        // Orientation 6 (rotate 90 CW): becomes 1x2, red on top.
        let cw = apply_orientation(img.clone(), 6);
        assert_eq!((cw.width, cw.height), (1, 2));
        assert_eq!(cw.pixel(0, 0)[0], 1.0, "red rotates to the top");
        assert_eq!(cw.pixel(0, 1)[1], 1.0, "green rotates to the bottom");

        // Orientation 8 (rotate 90 CCW): red at the bottom.
        let ccw = apply_orientation(img.clone(), 8);
        assert_eq!((ccw.width, ccw.height), (1, 2));
        assert_eq!(ccw.pixel(0, 1)[0], 1.0);

        // Orientation 3 (180): order flips.
        let flip = apply_orientation(img.clone(), 3);
        assert_eq!((flip.width, flip.height), (2, 1));
        assert_eq!(flip.pixel(0, 0)[1], 1.0);

        // Orientation 1 and out-of-range values are identity.
        assert_eq!(apply_orientation(img.clone(), 1), img);
        assert_eq!(apply_orientation(img.clone(), 0), img);
        assert_eq!(apply_orientation(img.clone(), 9), img);
    }

    /// A phone JPEG: pixels stored unrotated, an APP1 EXIF segment
    /// saying which way the camera was held. Every decode path must
    /// stand it upright; iPhone shots came in sideways and upside down
    /// before this was applied to plain files.
    #[test]
    fn scene_linear_jpegs_preserve_icc_and_every_exif_orientation() {
        let dir = tempfile::tempdir().unwrap();
        for orientation in 2..=8 {
            let bytes = std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/fixtures/stack-orientation-{orientation}.jpg"))).unwrap();
            let path = dir.path().join("oriented.jpg");
            std::fs::write(&path, &bytes).unwrap();
            let want = apply_orientation(decode_bytes(&bytes).unwrap(), orientation);
            let got = decode_any_scene_linear(&path, RawSourceOpts::default()).unwrap();
            assert_eq!((got.width, got.height), (want.width, want.height));
            for (a, b) in got.data.iter().zip(&want.data) { assert!((a - b).abs() < 0.015, "orientation {orientation}: {a} != {b}"); }
        }
    }

    #[test]
    fn plain_jpegs_stand_up_to_their_exif_orientation() {
        // Left half red, right half green; big blocks survive JPEG.
        let mut img = ImageBuf::new(16, 8);
        for y in 0..8 {
            for x in 0..16 {
                img.set_pixel(x, y, if x < 8 { [1.0, 0.0, 0.0, 1.0] } else { [0.0, 1.0, 0.0, 1.0] });
            }
        }
        let plain = encode_jpeg(&img, 95).unwrap();

        // Splice an APP1 after SOI: EXIF TIFF, IFD0, orientation 6.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"Exif\0\0");
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&6u16.to_le_bytes()); // rotate 90 CW
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpeg.extend_from_slice(&((tiff.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&tiff);
        jpeg.extend_from_slice(&plain[2..]);

        assert_eq!(media_orientation(&jpeg), 6);

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("phone.jpg");
        std::fs::write(&path, &jpeg).unwrap();

        for decoded in [
            decode_any_with(&path, RawSourceOpts::default()).unwrap(),
            decode_preview(&path).unwrap(),
            decode_thumbnail(&path).unwrap(),
        ] {
            assert_eq!((decoded.width, decoded.height), (8, 16), "90 CW swaps the frame");
            assert!(decoded.pixel(4, 2)[0] > 0.5, "red rotates to the top");
            assert!(decoded.pixel(4, 13)[1] > 0.5, "green rotates to the bottom");
        }
    }

    /// The status bar shows what source_dimensions returns as "the size
    /// of the photograph": header dims, stood upright by the EXIF
    /// orientation exactly the way the decode paths stand the pixels up.
    #[test]
    fn source_dimensions_read_headers_and_stand_upright() {
        let img = ImageBuf::filled(16, 8, [0.5, 0.5, 0.5, 1.0]);
        let plain = encode_jpeg(&img, 90).unwrap();
        assert_eq!(source_dimensions(&plain), Some((16, 8)));

        // Same pixels, EXIF orientation 6 (rotate 90 CW): the photograph
        // is a portrait, whatever the stored rows say.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"Exif\0\0");
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&6u16.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpeg.extend_from_slice(&((tiff.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&tiff);
        jpeg.extend_from_slice(&plain[2..]);
        assert_eq!(source_dimensions(&jpeg), Some((8, 16)));

        assert_eq!(source_dimensions(&[0u8, 1, 2, 3]), None);
    }

    /// An RW2: Panasonic's magic (85 where TIFF says 42), no standard
    /// size tags at all, and the frame declared only as sensor crop
    /// borders. The owner's P1456969.RW2 read as no size at all; the
    /// borders are where 6000x4000 actually lives.
    #[test]
    fn source_dimensions_read_rw2_sensor_borders() {
        let mut rw2 = Vec::new();
        rw2.extend_from_slice(b"II");
        rw2.extend_from_slice(&85u16.to_le_bytes());
        rw2.extend_from_slice(&8u32.to_le_bytes());
        rw2.extend_from_slice(&4u16.to_le_bytes()); // four entries
        for (tag, v) in [(0x0004u16, 4u16), (0x0005, 8), (0x0006, 3004), (0x0007, 4008)] {
            rw2.extend_from_slice(&tag.to_le_bytes());
            rw2.extend_from_slice(&3u16.to_le_bytes()); // SHORT
            rw2.extend_from_slice(&1u32.to_le_bytes());
            rw2.extend_from_slice(&v.to_le_bytes());
            rw2.extend_from_slice(&[0, 0]);
        }
        rw2.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(source_dimensions(&rw2), Some((4000, 3000)));
    }

    /// The admission probe reads a capped header prefix, not the whole
    /// file. Pinned with a budget that cannot hold the file: before the
    /// cap, the probe admitted every byte up front and refused here,
    /// even though the dimensions sit in the first kilobytes, and a
    /// stack or panorama paid that full read again at decode.
    #[test]
    fn a_paid_small_png_decode_covers_fixed_decoder_scratch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.png");
        std::fs::write(&path, encode_png(&ImageBuf::filled(4, 4, [0.25, 0.25, 0.25, 1.0])).unwrap()).unwrap();
        let estimate = probe_memory(&path).unwrap().unwrap();
        let paid = estimate.retained + estimate.workspace;
        let out = memory::with_budget(paid, || {
            let job = Job::admit(paid, "small PNG and decoder scratch").unwrap();
            job.worker(paid).run(|| decode_any(&path))
        }).unwrap();
        assert!((out.pixel(0, 0)[0] - 0.25).abs() < 0.02);
    }

    #[test]
    fn probe_memory_reads_headers_only_and_survives_a_tight_budget() {
        let dir = tempfile::tempdir().unwrap();
        let img = ImageBuf::filled(64, 32, [0.5, 0.5, 0.5, 1.0]);
        let mut bytes = encode_jpeg(&img, 90).unwrap();
        let file_len = 40 * 1024 * 1024;
        bytes.resize(file_len, 0); // decoders and the probe read the front
        let path = dir.path().join("padded.jpg");
        std::fs::write(&path, &bytes).unwrap();
        let estimate = heeler_engine::memory::with_budget(20 * 1024 * 1024, || {
            probe_memory(&path).unwrap()
        })
        .expect("header dims must fit a budget smaller than the file");
        assert_eq!((estimate.width, estimate.height), (64, 32));
        // The estimate still charges the true file size, prefix or not.
        assert_eq!(estimate.encoded, file_len);
    }

    /// A TIFF whose directory sits past the prefix is the prefix's miss:
    /// the probe falls back to a full read and still answers. Built by
    /// hand, since heeler's own writer now leads with the directory.
    #[test]
    fn probe_memory_falls_back_when_headers_live_past_the_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.tif");
        let bytes = tiff_with_directory_at_the_end(1200, 1200, PROBE_PREFIX);
        std::fs::write(&path, &bytes).unwrap();
        assert!(bytes.len() > PROBE_PREFIX);
        assert_eq!(source_dimensions(&bytes[..PROBE_PREFIX]), None, "the fixture must actually miss the prefix");
        assert_eq!(source_dimensions(&bytes), Some((1200, 1200)), "the fixture must read whole");
        let estimate = probe_memory(&path).unwrap().unwrap();
        assert_eq!((estimate.width, estimate.height), (1200, 1200));
        assert_eq!(estimate.encoded, bytes.len());
    }

    /// One 8-bit gray strip at offset 8, the directory after `gap` bytes.
    fn tiff_with_directory_at_the_end(w: u32, h: u32, gap: usize) -> Vec<u8> {
        let ifd_at = 8 + gap;
        let mut b = Vec::with_capacity(ifd_at + 2 + 9 * 12 + 4);
        b.extend_from_slice(b"II");
        b.extend_from_slice(&42u16.to_le_bytes());
        b.extend_from_slice(&(ifd_at as u32).to_le_bytes());
        b.resize(ifd_at, 0);
        const SHORT: u16 = 3;
        const LONG: u16 = 4;
        let entries: [(u16, u16, u32); 9] = [
            (256, LONG, w), (257, LONG, h), (258, SHORT, 8), (259, SHORT, 1), (262, SHORT, 1),
            (273, LONG, 8), (277, SHORT, 1), (278, LONG, h), (279, LONG, w * h),
        ];
        b.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, kind, value) in entries {
            b.extend_from_slice(&tag.to_le_bytes());
            b.extend_from_slice(&kind.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes());
            if kind == SHORT {
                b.extend_from_slice(&(value as u16).to_le_bytes());
                b.extend_from_slice(&[0, 0]);
            } else {
                b.extend_from_slice(&value.to_le_bytes());
            }
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        b
    }

    /// Heeler's own TIFFs lead with the directory, so a stack or
    /// panorama of heeler exports probes from the prefix like a JPEG.
    #[test]
    fn a_heeler_tiff_probes_from_its_prefix() {
        let bytes = encode_tiff16_export(&ImageBuf::filled(1200, 1200, [0.25; 4]), crate::TiffExportOptions { exif: None, ..Default::default() }).unwrap();
        assert!(bytes.len() > PROBE_PREFIX);
        assert_eq!(source_dimensions(&bytes[..PROBE_PREFIX]), Some((1200, 1200)));
    }

    /// A RAW's first directory is often its thumbnail, so a prefix that
    /// LibRaw cannot read yields no estimate at all (the probe goes on to
    /// the whole file) rather than the thumbnail's size.
    #[test]
    fn a_raw_prefix_answers_through_libraw_or_not_at_all() {
        let tiff = encode_tiff16_export(&ImageBuf::filled(64, 32, [0.25; 4]), crate::TiffExportOptions { exif: None, ..Default::default() }).unwrap();
        assert_eq!(source_dimensions(&tiff), Some((64, 32)), "the fixture must read as a TIFF");
        // Not a RAW LibRaw knows: with the feature on it refuses, with it
        // off there is no LibRaw. Either way the standard reader's answer
        // is withheld on a prefix and given on the whole file.
        assert!(estimate_from(&tiff, tiff.len(), true, true).unwrap().is_none());
        let whole = estimate_from(&tiff, tiff.len(), true, false).unwrap().unwrap();
        assert_eq!((whole.width, whole.height), (64, 32));
        // Not a RAW extension: the prefix answers as before.
        let plain = estimate_from(&tiff, tiff.len(), false, true).unwrap().unwrap();
        assert_eq!((plain.width, plain.height), (64, 32));
    }

    /// Stack and panorama discovery probe members that may have been moved
    /// away: a vanished file is an unknown, not an error, so the set is
    /// still discovered with the member listed as missing.
    #[test]
    fn probe_memory_treats_a_vanished_file_as_unknown() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("gone.png");
        assert!(probe_memory(&gone).unwrap().is_none());
    }

    #[test]
    fn decode_thumbnail_reads_standard_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.png");
        std::fs::write(&path, encode_png(&gradient(16, 8)).unwrap()).unwrap();
        let img = decode_thumbnail(&path).unwrap();
        assert_eq!((img.width, img.height), (16, 8));
        // Same pixels as the develop-quality decode for non-RAW files.
        let full = decode_any(&path).unwrap();
        assert_eq!(img, full);
    }

    #[test]
    fn a_gray8_plane_round_trips_byte_for_byte() {
        let (w, h) = (37usize, 11usize);
        let data: Vec<u8> = (0..w * h).map(|i| (i * 7 % 256) as u8).collect();
        let bytes = encode_png_gray8(&data, w, h).unwrap();
        let (bw, bh, back) = decode_png_gray8(&bytes).unwrap();
        assert_eq!((bw, bh), (w, h));
        assert_eq!(back, data);
    }

    #[test]
    fn png_round_trip_preserves_pixels_within_8bit_tolerance() {
        let original = gradient(16, 8);
        let bytes = encode_png(&original).unwrap();
        let decoded = decode_bytes(&bytes).unwrap();
        assert_eq!(decoded.width, 16);
        assert_eq!(decoded.height, 8);
        for i in 0..original.data.len() {
            assert!(
                (original.data[i] - decoded.data[i]).abs() < 0.01,
                "channel {i}: {} vs {}",
                original.data[i],
                decoded.data[i]
            );
        }
    }

    #[test]
    fn png_preserves_alpha() {
        let mut buf = ImageBuf::filled(2, 2, [0.5, 0.5, 0.5, 1.0]);
        buf.set_pixel(1, 1, [0.5, 0.5, 0.5, 0.25]);
        let decoded = decode_bytes(&encode_png(&buf).unwrap()).unwrap();
        assert!((decoded.pixel(1, 1)[3] - 0.25).abs() < 0.01);
        assert!((decoded.pixel(0, 0)[3] - 1.0).abs() < 0.01);
    }

    #[test]
    fn jpeg_encodes_and_decodes_with_correct_dimensions() {
        let original = gradient(32, 16);
        let bytes = encode_jpeg(&original, 90).unwrap();
        assert_eq!(detect_format(&bytes), Some(ImageFormat::Jpeg));
        let decoded = decode_bytes(&bytes).unwrap();
        assert_eq!(decoded.width, 32);
        assert_eq!(decoded.height, 16);
        // Lossy codec: loose tolerance, mid-gradient sample.
        let a = original.pixel(16, 8);
        let b = decoded.pixel(16, 8);
        assert!((a[0] - b[0]).abs() < 0.06);
    }

    #[test]
    fn garbage_bytes_error_cleanly() {
        assert!(decode_bytes(&[0x00, 0x01, 0x02, 0x03]).is_err());
    }
}


#[cfg(test)]
mod srgb_table_tests {
    use super::*;

    /// The table is the arithmetic, exactly: every f32 from 0 up to 1.0
    /// (a billion bit patterns, split over the cores) encodes to the
    /// same code both ways, so no exported or previewed pixel moves.
    #[test]
    fn the_srgb_table_matches_the_transfer_for_every_float_below_one() {
        let end = 1.0f32.to_bits();
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as u32;
        let chunk = end.div_ceil(threads);
        let bad: u64 = std::thread::scope(|s| {
            (0..threads)
                .map(|t| {
                    s.spawn(move || {
                        let (a, b) = (t * chunk, ((t + 1) * chunk).min(end));
                        (a..b).filter(|&bits| srgb_u8(f32::from_bits(bits)) != srgb_u8_direct(f32::from_bits(bits))).count() as u64
                    })
                })
                .collect::<Vec<_>>()
                .into_iter()
                .map(|h| h.join().unwrap())
                .sum()
        });
        assert_eq!(bad, 0, "bit patterns where the table and the transfer disagree");
    }

    /// And at and past the ends: zero, negatives, NaN, one, above one,
    /// infinity, the values a render can hand the encoder.
    #[test]
    fn the_srgb_table_matches_the_transfer_at_the_ends() {
        for v in [0.0f32, -0.0, -1e-9, -3.0, f32::NAN, f32::NEG_INFINITY, 1.0, 1.0000001, 1.5, 64.0, f32::INFINITY, f32::MIN_POSITIVE, 1e-40] {
            assert_eq!(srgb_u8(v), srgb_u8_direct(v), "{v}");
        }
    }
}

#[cfg(all(test, feature = "rawler"))]
mod review_rawler {
    #[test]
    #[ignore]
    fn real_phone_rawler_develop_is_rendered_and_upright() {
        let Some(list) = std::env::var_os("HEELER_PRORAW") else { return };
        for path in std::env::split_paths(&list).take(2) {
            let bytes = std::fs::read(&path).unwrap();
            let raw = super::decode_rawler(&path, &bytes).expect("real phone rawler decode");
            assert!(super::develop_looks_sane(&raw));
            let rendering = super::dng_gain::file_rendering(&bytes).unwrap();
            let mut oracle = raw.clone();
            super::dng_gain::render(&mut oracle, &rendering);
            let actual = super::as_the_file_renders(raw, &bytes);
            assert_eq!(actual.data, oracle.data);
            let orientation = super::raw_orientation(&bytes);
            assert_eq!(actual.width < actual.height, matches!(orientation, 5..=8));
            println!("{} rawler rendered {}x{} orientation {}", path.display(), actual.width, actual.height, orientation);
        }
    }
}
