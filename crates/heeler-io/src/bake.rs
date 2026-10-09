//! Writing a merge down to a real file.
//!
//! "I would like to add an option for stacks to bake an
//! image. To take the recipe and bake it down to an image on disk... the
//! baking should ask the user what format they want (JPG, TIFF, DNG
//! (default))."
//!
//! JPEG already had an encoder. The other two are here, and they share a
//! writer, because a DNG *is* a TIFF: same header, same tag table, just
//! with the handful of extra tags that say what the numbers mean. Writing
//! the container by hand rather than reaching for a DNG crate keeps the
//! dependency list where it is and, more to the point, keeps the license
//! list where it is.
//!
//! The formats are not interchangeable, and the difference is the whole
//! reason DNG is the default. A merge exists to hold highlights a single
//! frame could not: a sky two or three stops over scene white comes back
//! as values above 1.0. TIFF and JPEG are display-referred, so those
//! values clip on the way out and the merge has been thrown away in the
//! act of saving it. The DNG keeps them, by scaling the whole frame to
//! fit and recording the scale it used as an exposure offset, which is
//! exactly what that tag is for.

use heeler_engine::ImageBuf;

use crate::{linear_to_srgb, Exif, IoError};

// TIFF field types, from the TIFF 6.0 spec.
const BYTE: u16 = 1;
const ASCII: u16 = 2;
const SHORT: u16 = 3;
const LONG: u16 = 4;
const RATIONAL: u16 = 5;
const UNDEFINED: u16 = 7;
const SRATIONAL: u16 = 10;

/// One tag, with its value already laid out as bytes.
struct Field {
    tag: u16,
    kind: u16,
    count: u32,
    payload: Vec<u8>,
}

fn shorts(tag: u16, values: &[u16]) -> Field {
    let mut payload = Vec::with_capacity(values.len() * 2);
    for v in values {
        payload.extend_from_slice(&v.to_le_bytes());
    }
    Field { tag, kind: SHORT, count: values.len() as u32, payload }
}

fn longs(tag: u16, values: &[u32]) -> Field {
    let mut payload = Vec::with_capacity(values.len() * 4);
    for v in values {
        payload.extend_from_slice(&v.to_le_bytes());
    }
    Field { tag, kind: LONG, count: values.len() as u32, payload }
}

fn bytes(tag: u16, values: &[u8]) -> Field {
    Field { tag, kind: BYTE, count: values.len() as u32, payload: values.to_vec() }
}

fn ascii(tag: u16, text: &str) -> Field {
    let mut payload = text.as_bytes().to_vec();
    payload.push(0);
    Field { tag, kind: ASCII, count: payload.len() as u32, payload }
}

fn undefined(tag: u16, values: &[u8]) -> Field {
    Field { tag, kind: UNDEFINED, count: values.len() as u32, payload: values.to_vec() }
}

fn rationals(tag: u16, values: &[(u32, u32)]) -> Field {
    let mut payload = Vec::with_capacity(values.len() * 8);
    for (n, d) in values {
        payload.extend_from_slice(&n.to_le_bytes());
        payload.extend_from_slice(&d.to_le_bytes());
    }
    Field { tag, kind: RATIONAL, count: values.len() as u32, payload }
}

fn srationals(tag: u16, values: &[(i32, i32)]) -> Field {
    let mut payload = Vec::with_capacity(values.len() * 8);
    for (n, d) in values {
        payload.extend_from_slice(&n.to_le_bytes());
        payload.extend_from_slice(&d.to_le_bytes());
    }
    Field { tag, kind: SRATIONAL, count: values.len() as u32, payload }
}

/// Assembles a little-endian TIFF: header, one IFD with its out-of-line
/// values, then one strip of pixels.
///
/// Uncompressed and single-strip, which for a file that exists to be read
/// back is the right trade: it is written once and the simplicity is
/// worth more than the megabytes.
///
/// The directory leads the file on purpose. Whatever wants the size
/// first (the admission probe, a file browser, a print pipeline's first
/// look) finds it in the first kilobyte instead of past a hundred
/// megabytes of pixels. A directory parked at the end made every
/// heeler-written TIFF the one file the header-only probe had to read
/// whole.
///
/// `fields` must be sorted by tag. Readers are entitled to binary-search
/// the directory, so an out-of-order tag is a file that some decoders
/// read and others do not, which is the worst kind of broken.
fn write_tiff(pixels: &[u8], mut fields: Vec<Field>) -> Vec<u8> {
    fields.sort_by_key(|f| f.tag);
    debug_assert!(
        fields.windows(2).all(|p| p[0].tag < p[1].tag),
        "duplicate tag in a TIFF directory",
    );

    const HEADER: usize = 8;
    let dir_len = 2 + fields.len() * 12 + 4;
    let value_base = HEADER + dir_len;
    // Where the strip lands is known before a byte is written: the
    // directory's size and its out-of-line values are in hand. The strip
    // offset itself is one inline LONG, so setting it moves nothing.
    let pixels_at = value_base + out_of_line_len(fields.iter().map(|f| f.payload.len()));
    set_strip_offset(&mut fields, pixels_at);

    let capacity = heeler_engine::memory::or_unwind(heeler_engine::memory::sum([pixels_at, pixels.len()]));
    let _job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(capacity, "TIFF output and metadata"));
    let mut out = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(capacity, 0u8, "TIFF output"));
    out.clear();
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&(HEADER as u32).to_le_bytes());

    let mut values: Vec<u8> = Vec::new();
    out.extend_from_slice(&(fields.len() as u16).to_le_bytes());
    for f in &fields {
        out.extend_from_slice(&f.tag.to_le_bytes());
        out.extend_from_slice(&f.kind.to_le_bytes());
        out.extend_from_slice(&f.count.to_le_bytes());
        if f.payload.len() <= 4 {
            // Small values live in the entry itself, left-aligned.
            let mut inline = f.payload.clone();
            inline.resize(4, 0);
            out.extend_from_slice(&inline);
        } else {
            out.extend_from_slice(&((value_base + values.len()) as u32).to_le_bytes());
            values.extend_from_slice(&f.payload);
            // Every value must start on an even boundary too.
            if values.len() & 1 == 1 {
                values.push(0);
            }
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // no second directory
    out.extend_from_slice(&values);
    debug_assert_eq!(out.len(), pixels_at);
    out.extend_from_slice(pixels);
    out
}

/// The bytes the out-of-line values take, each padded so the next
/// starts on an even offset, exactly as the directory writers lay them.
fn out_of_line_len(payloads: impl Iterator<Item = usize>) -> usize {
    payloads.filter(|n| *n > 4).map(|n| n + (n & 1)).sum()
}

fn set_strip_offset(fields: &mut [Field], at: usize) {
    if let Some(f) = fields.iter_mut().find(|f| f.tag == 273) {
        *f = longs(273, &[at as u32]);
    }
}

/// The strip's length in bytes, or a refusal when it will not fit the
/// tag that has to carry it. TIFF's counts and offsets are 32-bit, so a
/// frame past 4 GB is BigTIFF's job; until this writer speaks it, a
/// bake that large is refused rather than written with a truncated
/// StripByteCounts, which is a file that reads back torn or not at all.
fn strip_len(width: usize, height: usize) -> Result<usize, IoError> {
    let n = heeler_engine::memory::bytes(width, height, 1, 6)?;
    if n > u32::MAX as usize {
        return Err(IoError::Unsupported(format!(
            "{width} by {height} is {n} bytes of pixels, past the 4 GB a TIFF directory can point at; this writer does not write BigTIFF"
        )));
    }
    Ok(n)
}

/// Tags every image in here carries, whatever it is a picture of.
/// `samples` is 3 or 4 (a fourth sample is unassociated alpha, tag 338,
/// said so rather than left for the reader to guess), `bits` the depth
/// of each sample (16 or 32), `format` the TIFF SampleFormat (1 unsigned
/// integer, 3 IEEE float).
fn common(width: usize, height: usize, strip_bytes: usize, photometric: u16, samples: u16, bits: u16, format: u16) -> Vec<Field> {
    let mut fields = vec![
        longs(254, &[0]),                       // NewSubfileType: the real image
        longs(256, &[width as u32]),            // ImageWidth
        longs(257, &[height as u32]),           // ImageLength
        shorts(258, &vec![bits; samples as usize]), // BitsPerSample
        shorts(259, &[1]),                      // Compression: none
        shorts(262, &[photometric]),            // PhotometricInterpretation
        longs(273, &[0]),                       // StripOffsets: set by the writer, after the directory
        shorts(274, &[1]),                      // Orientation: as written
        shorts(277, &[samples]),                // SamplesPerPixel
        longs(278, &[height as u32]),           // RowsPerStrip: all of them
        longs(279, &[strip_bytes as u32]),      // StripByteCounts
        shorts(284, &[1]),                      // PlanarConfiguration: interleaved
        shorts(339, &vec![format; samples as usize]), // SampleFormat
        ascii(305, "Heeler"),                   // Software
    ];
    if samples == 4 {
        // ExtraSamples: the fourth sample is unassociated (straight)
        // alpha, which is what ImageBuf carries and what PNG writes.
        fields.push(shorts(338, &[2]));
    }
    fields
}

/// Whether the buffer carries any transparency worth a fourth sample.
/// An all-opaque buffer writes three samples as it always did, since
/// some readers treat an alpha channel as an invitation to premultiply.
fn wants_alpha(buf: &ImageBuf) -> bool {
    buf.data.chunks_exact(4).any(|px| px[3] < 1.0)
}

/// The display-referred pixel loop both 16-bit TIFFs share: sRGB-encoded
/// color, and when any alpha is below 1 a fourth sample, left LINEAR
/// (alpha is coverage, not color; the transfer curve is for light).
fn srgb16_pixels(buf: &ImageBuf, alpha: bool) -> Result<Vec<u8>, IoError> {
    let mut pixels = crate::encode_capacity(buf, if alpha { 8 } else { 6 })?;
    for i in 0..buf.width * buf.height {
        for c in 0..3 {
            let v = linear_to_srgb(buf.data[i * 4 + c].clamp(0.0, 1.0));
            pixels.extend_from_slice(&((v * 65535.0).round() as u16).to_le_bytes());
        }
        if alpha {
            let a = buf.data[i * 4 + 3].clamp(0.0, 1.0);
            pixels.extend_from_slice(&((a * 65535.0).round() as u16).to_le_bytes());
        }
    }
    Ok(pixels)
}

/// 16 bits per channel, sRGB encoded, alpha when the buffer has any.
///
/// Display-referred on purpose: this is the format you pick when the
/// baked file is going somewhere else, and everywhere else expects sRGB.
/// Anything above scene white clips, which is the cost of asking for it.
pub fn encode_tiff16(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| encode_tiff16_admitted(buf)).map_err(IoError::from).and_then(|v| v)
}

fn encode_tiff16_admitted(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 32)?, 64 * 1024])?, "TIFF/DNG encode and metadata")?;
    if buf.width == 0 || buf.height == 0 {
        return Err(IoError::UnsupportedFormat);
    }
    strip_len(buf.width, buf.height)?;
    let alpha = wants_alpha(buf);
    let pixels = srgb16_pixels(buf, alpha)?;
    let mut fields = common(buf.width, buf.height, pixels.len(), 2, if alpha { 4 } else { 3 }, 16, 1); // RGB
    fields.push(ascii(270, "Baked by Heeler"));
    // InterColorProfile: the file says what its numbers mean instead of
    // hoping the reader guesses sRGB. The DNG deliberately does NOT get
    // this: its data is scene-referred linear, and stamping a display
    // profile on it would be a lie about the image state.
    fields.push(undefined(34675, crate::icc::srgb_profile()));
    Ok(write_tiff(&pixels, fields))
}

/// The export form of the 16-bit TIFF: the same display-referred sRGB
/// pixels as a bake, but described as an export and, when the source
/// file had a camera record, carrying it as a real Exif directory
/// (tag 34665) inside the file. The JPEG and PNG exports splice that
/// record into the encoded bytes after the fact; a TIFF's metadata lives
/// in its own directory structure, so it is written on the way out.
pub fn encode_tiff16_export(buf: &ImageBuf, options: TiffExportOptions<'_>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| encode_tiff16_export_admitted(buf, options.exif, options.xmp, options.dpi)).map_err(IoError::from).and_then(|v| v)
}

/// Metadata and print settings for a display-referred TIFF export.
#[derive(Clone, Copy)]
pub struct TiffExportOptions<'a> {
    pub exif: Option<&'a Exif>,
    pub xmp: Option<&'a str>,
    pub dpi: u32,
}

impl Default for TiffExportOptions<'_> {
    fn default() -> Self {
        Self { exif: None, xmp: None, dpi: crate::resolution::DEFAULT_DPI }
    }
}

fn encode_tiff16_export_admitted(buf: &ImageBuf, exif: Option<&Exif>, xmp: Option<&str>, dpi: u32) -> Result<Vec<u8>, IoError> {
    let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 32)?, 64 * 1024])?, "TIFF/DNG encode and metadata")?;
    if buf.width == 0 || buf.height == 0 {
        return Err(IoError::UnsupportedFormat);
    }
    strip_len(buf.width, buf.height)?;
    let alpha = wants_alpha(buf);
    let pixels = srgb16_pixels(buf, alpha)?;
    let mut fields = common(buf.width, buf.height, pixels.len(), 2, if alpha { 4 } else { 3 }, 16, 1); // RGB
    fields.push(ascii(270, "Exported by Heeler"));
    fields.push(undefined(34675, crate::icc::srgb_profile()));
    // Print pipelines read their resolution and their camera from the
    // FIRST directory; the Exif one only holds the shooting details.
    // Orientation and Software are already in common(), so they are not
    // repeated here: a duplicated tag is a corrupt directory.
    fields.extend(resolution_fields(dpi));
    if let Some(e) = exif.filter(|e| !e.is_empty()) {
        if let Some(v) = &e.make {
            fields.push(ascii(271, v));
        }
        if let Some(v) = &e.model {
            fields.push(ascii(272, v));
        }
        if let Some(v) = &e.shot_at {
            fields.push(ascii(306, v));
        }
        if let Some(v) = &e.artist {
            fields.push(ascii(315, v));
        }
        if let Some(v) = &e.copyright {
            fields.push(ascii(33432, v));
        }
    }
    if let Some(packet) = xmp {
        fields.push(bytes(crate::exif::TAG_XMP, packet.as_bytes()));
    }

    let sub = exif
        .filter(|e| !e.is_empty())
        .map(|e| crate::exif::exif_sub_entries(e, buf.width as u32, buf.height as u32))
        .unwrap_or_default();
    if sub.is_empty() {
        return Ok(write_tiff(&pixels, fields));
    }
    Ok(write_tiff_with_exif(&pixels, fields, sub))
}

/// A Finish layer's 16-bit TIFF sibling (26.3 Phase 7): always four
/// samples, ExtraSamples unassociated, because a layer IS its alpha and
/// an all-opaque layer still wants the channel a compositor expects.
/// Display-referred sRGB like the beauty it sits beside; the blend
/// mode, opacity and group ride in the description tag as a record no
/// reader acts on.
pub fn encode_tiff16_layer(buf: &ImageBuf, description: &str, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| {
        let _job = heeler_engine::memory::Job::admit(
            heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 32)?, 64 * 1024])?,
            "TIFF layer encode",
        )?;
        if buf.width == 0 || buf.height == 0 {
            return Err(IoError::UnsupportedFormat);
        }
        strip_len(buf.width, buf.height)?;
        let pixels = srgb16_pixels(buf, true)?;
        let mut fields = common(buf.width, buf.height, pixels.len(), 2, 4, 16, 1); // RGBA
        fields.push(ascii(270, description));
        fields.push(undefined(34675, crate::icc::srgb_profile()));
        if let Some(dpi) = dpi { fields.extend(resolution_fields(dpi)); }
        Ok(write_tiff(&pixels, fields))
    })
    .map_err(IoError::from)
    .and_then(|v| v)
}

/// 32-bit float TIFF (26.3 Phase 3b): the scene-linear numbers as the
/// engine holds them, no transfer curve, no clamp, no ICC. SampleFormat 3
/// (IEEE float), 32 bits a sample, and a description tag saying the
/// numbers are linear Rec.709, since no profile tag will say it. Compositors
/// and layer editors read it. This is the linear choice for a file going to
/// compositing; the 16-bit TIFF is the display-referred one.
///
/// `include_alpha` writes a fourth sample (unassociated alpha, as the
/// 16-bit writer's). Callers with an opaque buffer pass false and get
/// three samples.
pub fn encode_tiff32f(buf: &ImageBuf, options: FloatTiffOptions) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| encode_tiff32f_admitted(buf, options.include_alpha, options.dpi)).map_err(IoError::from).and_then(|v| v)
}

/// Float bakes keep no print size; exports explicitly supply their resolution.
#[derive(Clone, Copy, Default)]
pub struct FloatTiffOptions {
    pub include_alpha: bool,
    pub dpi: Option<u32>,
}

/// XResolution, YResolution and ResolutionUnit (inch) for IFD0, where
/// print pipelines read them.
fn resolution_fields(dpi: u32) -> [Field; 3] {
    let dpi = crate::resolution::clamp_dpi(dpi);
    [rationals(282, &[(dpi, 1)]), rationals(283, &[(dpi, 1)]), shorts(296, &[2])]
}

fn encode_tiff32f_admitted(buf: &ImageBuf, include_alpha: bool, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "TIFF32f encode")?;
    if buf.width == 0 || buf.height == 0 {
        return Err(IoError::UnsupportedFormat);
    }
    strip_len(buf.width, buf.height)?;
    let samples = if include_alpha { 4 } else { 3 };
    let mut pixels = crate::encode_capacity(buf, samples * 4)?;
    for i in 0..buf.width * buf.height {
        for c in 0..3 {
            pixels.extend_from_slice(&buf.data[i * 4 + c].to_le_bytes());
        }
        if include_alpha {
            pixels.extend_from_slice(&buf.data[i * 4 + 3].to_le_bytes());
        }
    }
    let mut fields = common(buf.width, buf.height, pixels.len(), 2, samples as u16, 32, 3); // RGB, float
    fields.push(ascii(
        270,
        &format!("Linear Rec.709 scene-referred float, written by Heeler {}", env!("CARGO_PKG_VERSION")),
    ));
    if let Some(dpi) = dpi {
        fields.extend(resolution_fields(dpi));
    }
    Ok(write_tiff(&pixels, fields))
}

/// A Finish layer's 16-bit TIFF sibling written AS IS (26.3 Phase 8):
/// the stack composites in display space, so the buffer is already
/// display-referred and the sRGB curve encode_tiff16_layer applies
/// would encode it twice. Four samples, ExtraSamples unassociated, the
/// same description record.
pub fn encode_tiff16_layer_display(buf: &ImageBuf, description: &str, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    tiff16_display(buf, description, true, dpi)
}

/// The same file with no ICC profile (New Layer via Copy's kept pixels,
/// 2026-09-30): Heeler reads an untagged file as sRGB through the curve
/// alone, bit exact, where a tagged one also takes the profile's
/// colorants through a D50 matrix and comes back a ten-thousandth off.
/// For a file only Heeler reads back.
pub fn encode_tiff16_display_untagged(buf: &ImageBuf, description: &str) -> Result<Vec<u8>, IoError> {
    tiff16_display(buf, description, false, None)
}

fn tiff16_display(buf: &ImageBuf, description: &str, icc: bool, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| {
        let _job = heeler_engine::memory::Job::admit(
            heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 32)?, 64 * 1024])?,
            "TIFF layer encode",
        )?;
        if buf.width == 0 || buf.height == 0 {
            return Err(IoError::UnsupportedFormat);
        }
        strip_len(buf.width, buf.height)?;
        let mut pixels = crate::encode_capacity(buf, 8)?;
        // Across the cores a row at a time: a Bake Warp of a whole
        // 24-megapixel frame waits on this conversion.
        pixels.resize(buf.width * buf.height * 8, 0);
        {
            use rayon::prelude::*;
            let row = buf.width * 8;
            pixels.par_chunks_mut(row.max(1)).enumerate().for_each(|(y, out)| {
                let src = &buf.data[y * buf.width * 4..(y + 1) * buf.width * 4];
                for (o, v) in out.chunks_exact_mut(2).zip(src) {
                    o.copy_from_slice(&((v.clamp(0.0, 1.0) * 65535.0).round() as u16).to_le_bytes());
                }
            });
        }
        let mut fields = common(buf.width, buf.height, pixels.len(), 2, 4, 16, 1); // RGBA
        fields.push(ascii(270, description));
        if icc {
            fields.push(undefined(34675, crate::icc::srgb_profile()));
        }
        if let Some(dpi) = dpi { fields.extend(resolution_fields(dpi)); }
        Ok(write_tiff(&pixels, fields))
    })
    .map_err(IoError::from)
    .and_then(|v| v)
}

/// A Finish layer's float TIFF sibling (26.3 Phase 7): the 32f form of
/// encode_tiff16_layer, always RGBA. The stack is display-referred, so
/// the caller linearizes the colors before they reach here; the
/// description says whose layer it was and that a linear merge will not
/// reproduce the display-space composite.
pub fn encode_tiff32f_layer(buf: &ImageBuf, description: &str, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| {
        let _job = heeler_engine::memory::Job::admit(
            heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?,
            "TIFF32f layer encode",
        )?;
        if buf.width == 0 || buf.height == 0 {
            return Err(IoError::UnsupportedFormat);
        }
        strip_len(buf.width, buf.height)?;
        let mut pixels = crate::encode_capacity(buf, 16)?;
        for i in 0..buf.width * buf.height {
            for c in 0..4 {
                pixels.extend_from_slice(&buf.data[i * 4 + c].to_le_bytes());
            }
        }
        let mut fields = common(buf.width, buf.height, pixels.len(), 2, 4, 32, 3); // RGBA, float
        fields.push(ascii(270, description));
        if let Some(dpi) = dpi { fields.extend(resolution_fields(dpi)); }
        Ok(write_tiff(&pixels, fields))
    })
    .map_err(IoError::from)
    .and_then(|v| v)
}

/// A single-sample gray TIFF (26.3 Phase 5): the sibling file an export
/// writes for each Export Channel node when the beauty is a 16-bit TIFF.
/// Display-encoded like the beauty it sits beside (sRGB, clamped), one
/// sample a pixel, BlackIsZero, no alpha: a matte is coverage, and a
/// reader that premultiplies a lone gray against itself would be
/// inventing data.
pub fn encode_tiff16_grey(plane: &[f32], width: usize, height: usize, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| {
        let _job = heeler_engine::memory::Job::admit(
            heeler_engine::memory::sum([heeler_engine::memory::bytes(width, height, 1, 16)?, 64 * 1024])?,
            "TIFF gray encode",
        )?;
        encode_tiff16_grey_admitted(plane, width, height, dpi)
    })
    .map_err(IoError::from)
    .and_then(|v| v)
}

fn encode_tiff16_grey_admitted(plane: &[f32], width: usize, height: usize, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    if width == 0 || height == 0 || plane.len() != width * height {
        return Err(IoError::UnsupportedFormat);
    }
    strip_len(width, height)?;
    let mut pixels = Vec::with_capacity(width * height * 2);
    for v in plane {
        let s = linear_to_srgb(v.clamp(0.0, 1.0));
        pixels.extend_from_slice(&((s * 65535.0).round() as u16).to_le_bytes());
    }
    let mut fields = common(width, height, pixels.len(), 1, 1, 16, 1); // BlackIsZero, one sample
    fields.push(ascii(270, "Gray channel exported by Heeler"));
    fields.push(undefined(34675, crate::icc::srgb_profile()));
    if let Some(dpi) = dpi { fields.extend(resolution_fields(dpi)); }
        Ok(write_tiff(&pixels, fields))
}

/// The float form of the sibling gray (26.3 Phase 5), for a 32-bit
/// beauty: the channel's scene-linear numbers as rendered, no transfer
/// curve, no clamp, one 32-bit float sample a pixel.
pub fn encode_tiff32f_grey(plane: &[f32], width: usize, height: usize, dpi: Option<u32>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| {
        let _job = heeler_engine::memory::Job::admit(
            heeler_engine::memory::sum([heeler_engine::memory::bytes(width, height, 1, 16)?, 64 * 1024])?,
            "TIFF32f gray encode",
        )?;
        if width == 0 || height == 0 || plane.len() != width * height {
            return Err(IoError::UnsupportedFormat);
        }
        strip_len(width, height)?;
        let mut pixels = Vec::with_capacity(width * height * 4);
        for v in plane {
            pixels.extend_from_slice(&v.to_le_bytes());
        }
        let mut fields = common(width, height, pixels.len(), 1, 1, 32, 3); // BlackIsZero, float
        fields.push(ascii(
            270,
            &format!("Linear scene-referred float gray channel, written by Heeler {}", env!("CARGO_PKG_VERSION")),
        ));
        if let Some(dpi) = dpi { fields.extend(resolution_fields(dpi)); }
        Ok(write_tiff(&pixels, fields))
    })
    .map_err(IoError::from)
    .and_then(|v| v)
}

/// A TIFF with two directories: the image's own, then the Exif one it
/// points at (tag 34665), then one shared out-of-line value region, then
/// the pixel strip. The same layout the standalone Exif block uses, with
/// the strip after it, and the same directory-first shape as write_tiff.
fn write_tiff_with_exif(
    pixels: &[u8],
    mut fields: Vec<Field>,
    sub: Vec<crate::exif::Entry>,
) -> Vec<u8> {
    fields.sort_by_key(|f| f.tag);
    debug_assert!(
        fields.windows(2).all(|p| p[0].tag < p[1].tag),
        "duplicate tag in a TIFF directory",
    );

    const HEADER: usize = 8;
    let dir_len = |n: usize| 2 + n * 12 + 4;
    let ifd0_at = HEADER;
    // +1 on the first directory: the Exif pointer rides with its entries.
    let exif_at = ifd0_at + dir_len(fields.len() + 1);
    let values_at = exif_at + dir_len(sub.len());
    let pixels_at = values_at
        + out_of_line_len(fields.iter().map(|f| f.payload.len()).chain(sub.iter().map(|e| e.payload.len())));
    set_strip_offset(&mut fields, pixels_at);

    let capacity = heeler_engine::memory::or_unwind(heeler_engine::memory::sum([pixels_at, pixels.len()]));
    let _job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(capacity, "TIFF output and EXIF"));
    let mut out = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(capacity, 0u8, "TIFF output and EXIF"));
    out.clear();
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&(ifd0_at as u32).to_le_bytes());

    let mut entries: Vec<crate::exif::Entry> = fields
        .into_iter()
        .map(|f| crate::exif::Entry {
            tag: f.tag,
            kind: f.kind,
            count: f.count,
            payload: f.payload,
        })
        .collect();
    entries.push(crate::exif::Entry {
        tag: 34665,
        kind: LONG,
        count: 1,
        payload: (exif_at as u32).to_le_bytes().to_vec(),
    });
    let mut values = Vec::new();
    out.extend_from_slice(&crate::exif::write_dir(entries, values_at, &mut values));
    out.extend_from_slice(&crate::exif::write_dir(sub, values_at, &mut values));
    out.extend_from_slice(&values);
    debug_assert_eq!(out.len(), pixels_at);
    out.extend_from_slice(pixels);
    out
}

/// The scale a linear bake needs to fit in 16 unsigned bits, and the
/// exposure offset that undoes it.
///
/// Split out because it is the one piece of judgment in the DNG writer
/// and it is worth being able to test on its own. A frame that never goes
/// above scene white is left exactly where it is: scaling it anyway would
/// mean every baked file carried a different exposure for no reason.
pub fn linear_headroom(buf: &ImageBuf) -> (f32, f32) {
    let peak = buf
        .data
        .chunks_exact(4)
        .flat_map(|px| px[..3].iter())
        .fold(0.0f32, |a, &b| if b > a { b } else { a });
    if !peak.is_finite() || peak <= 1.0 {
        return (1.0, 0.0);
    }
    (peak, peak.log2())
}

/// A linear DNG: 16-bit, scene-referred, one sample per channel.
///
/// The default, because it is the only one of the three that does not
/// throw away what the merge was for. Written as LinearRaw rather than as
/// a mosaic, since there is no mosaic left to write: the frames were
/// demosaiced before they were merged, and pretending otherwise would
/// mean inventing a CFA pattern the data does not have.
///
/// Highlights above scene white are kept by scaling the frame down to fit
/// and recording BaselineExposure, which is the tag that says "shift this
/// by so many stops when you render it". A reader that honors it gets
/// the picture back exactly; one that ignores it gets a dark picture
/// rather than a clipped one, which is the failure worth having.
pub fn encode_dng(buf: &ImageBuf, exif: Option<&Exif>) -> Result<Vec<u8>, IoError> {
    encode_dng_with_xmp(buf, exif, None)
}

/// The DNG with the catalog's keywords as IFD0's tag 700, written at
/// encode time for the same reason as the TIFF export: a splice would
/// move the directory to the file's end.
pub fn encode_dng_with_xmp(buf: &ImageBuf, exif: Option<&Exif>, xmp: Option<&str>) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| encode_dng_admitted(buf, exif, xmp, None)).map_err(IoError::from).and_then(|v| v)
}

/// Encodes rendered edits with an explicit fresh-recipe marker and source filename.
pub fn encode_baked_dng(buf: &ImageBuf, exif: Option<&Exif>, xmp: &str, origin: &str) -> Result<Vec<u8>, IoError> {
    heeler_engine::memory::catch(|| encode_dng_admitted(buf, exif, Some(xmp), Some(origin)))
        .map_err(IoError::from).and_then(|v| v)
}

fn encode_dng_admitted(buf: &ImageBuf, exif: Option<&Exif>, xmp: Option<&str>, origin: Option<&str>) -> Result<Vec<u8>, IoError> {
    let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([heeler_engine::memory::bytes(buf.width, buf.height, 1, 32)?, 64 * 1024])?, "TIFF/DNG encode and metadata")?;
    if buf.width == 0 || buf.height == 0 {
        return Err(IoError::UnsupportedFormat);
    }
    strip_len(buf.width, buf.height)?;
    let (scale, stops) = linear_headroom(buf);
    let mut pixels = crate::encode_capacity(buf, 6)?;
    for i in 0..buf.width * buf.height {
        for c in 0..3 {
            let v = (buf.data[i * 4 + c] / scale).clamp(0.0, 1.0);
            pixels.extend_from_slice(&((v * 65535.0).round() as u16).to_le_bytes());
        }
    }

    // XYZ (D65) to linear sRGB. The merge came out of the engine in
    // linear sRGB, so as far as a DNG reader is concerned that IS the
    // camera's color space, and this is the matrix that gets there.
    const XYZ_TO_SRGB: [f32; 9] = [
        3.2406, -1.5372, -0.4986, //
        -0.9689, 1.8758, 0.0415, //
        0.0557, -0.2040, 1.0570,
    ];
    let matrix: Vec<(i32, i32)> = XYZ_TO_SRGB
        .iter()
        .map(|v| ((v * 10_000.0).round() as i32, 10_000))
        .collect();

    // The camera record, when the caller has one to carry (the export
    // paths and rendered bakes do): make and model take over IFD0's
    // 271/272 rather than duplicating the tags, and the shooting
    // details become a real Exif directory, the same layout the 16-bit
    // TIFF export writes. With None every tag below is exactly what
    // the bake has always written.
    let record = exif.filter(|e| !e.is_empty());
    let mut fields = common(buf.width, buf.height, pixels.len(), 34892, 3, 16, 1); // LinearRaw
    if let Some(origin) = origin {
        fields.retain(|field| field.tag != 305);
        fields.push(ascii(305, "Heeler Rendered Bake"));
        fields.push(ascii(50827, origin));
    }
    fields.extend([
        ascii(271, record.and_then(|e| e.make.as_deref()).unwrap_or("Heeler")), // Make
        ascii(272, record.and_then(|e| e.model.as_deref()).unwrap_or("Bake")), // Model
        bytes(50706, &[1, 4, 0, 0]),                           // DNGVersion
        bytes(50707, &[1, 1, 0, 0]),                           // DNGBackwardVersion
        ascii(50708, BAKE_CAMERA_MODEL),                       // UniqueCameraModel
        longs(50714, &[0]),                                    // BlackLevel
        longs(50717, &[65535]),                                // WhiteLevel
        srationals(50721, &matrix),                            // ColorMatrix1
        rationals(50728, &[(1, 1), (1, 1), (1, 1)]),           // AsShotNeutral
        srationals(50730, &[((stops * 10_000.0).round() as i32, 10_000)]), // BaselineExposure
        shorts(50778, &[21]),                                  // CalibrationIlluminant1: D65
    ]);
    if let Some(e) = record {
        if let Some(v) = &e.shot_at {
            fields.push(ascii(306, v));
        }
        if let Some(v) = &e.artist {
            fields.push(ascii(315, v));
        }
        if let Some(v) = &e.copyright {
            fields.push(ascii(33432, v));
        }
    }
    if let Some(packet) = xmp {
        fields.push(bytes(crate::exif::TAG_XMP, packet.as_bytes()));
    }
    let sub = record
        .map(|e| crate::exif::exif_sub_entries(e, buf.width as u32, buf.height as u32))
        .unwrap_or_default();
    if sub.is_empty() {
        return Ok(write_tiff(&pixels, fields));
    }
    Ok(write_tiff_with_exif(&pixels, fields, sub))
}

/// What the app stamps into UniqueCameraModel on a bake.
///
/// A marker, so reading the exposure offset back applies only to files
/// this app wrote. Camera DNGs carry a BaselineExposure too, usually half
/// a stop either way, and it is left alone: the same camera's native RAW
/// carries no such tag, so honoring it would render a converted DNG and
/// its original differently. (No decoder applies it. A phone's DNG,
/// whose exposure runs to four stops and comes with a gain table map,
/// is rendered by src/dng_gain.rs.)
pub const BAKE_CAMERA_MODEL: &str = "Heeler Bake";

/// The exposure offset a Heeler-baked DNG was written with, in stops.
///
/// None for anything else, including every DNG a camera produced.
pub fn baked_exposure(bytes: &[u8]) -> Option<f32> {
    let little = match bytes.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| -> Option<u16> {
        let b = bytes.get(at..at + 2)?;
        Some(if little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    };
    let u32_at = |at: usize| -> Option<u32> {
        let b = bytes.get(at..at + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    };
    if u16_at(2)? != 42 {
        return None;
    }
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;

    let mut ours = false;
    let mut stops = None;
    for i in 0..count.min(512) {
        let e = ifd + 2 + i * 12;
        let (tag, _kind, n, value) = (u16_at(e)?, u16_at(e + 2)?, u32_at(e + 4)?, u32_at(e + 8)?);
        match tag {
            50708 => {
                // ASCII, and long enough to have been placed out of line.
                let at = value as usize;
                let text = bytes.get(at..at + n as usize)?;
                ours = text.starts_with(BAKE_CAMERA_MODEL.as_bytes());
            }
            50730 => {
                let at = value as usize;
                let num = i32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?);
                let den = i32::from_le_bytes(bytes.get(at + 4..at + 8)?.try_into().ok()?);
                let num = if little { num } else { num.swap_bytes() };
                let den = if little { den } else { den.swap_bytes() };
                if den != 0 {
                    stops = Some(num as f32 / den as f32);
                }
            }
            _ => {}
        }
    }
    if ours {
        stops
    } else {
        None
    }
}

/// A Bayer (RGGB) DNG of the given 16-bit mosaic, for tests that need
/// sensor data a real develop has to demosaic: the repository carries
/// no camera RAW. Uncompressed CFA, black 0, white 65535, the sRGB
/// primaries as the camera's, neutral as-shot.
#[cfg(all(test, feature = "libraw"))]
pub(crate) fn encode_cfa_dng(mosaic: &[u16], width: usize, height: usize) -> Vec<u8> {
    assert_eq!(mosaic.len(), width * height);
    let mut pixels = Vec::with_capacity(mosaic.len() * 2);
    for v in mosaic {
        pixels.extend_from_slice(&v.to_le_bytes());
    }
    const XYZ_TO_SRGB: [f32; 9] = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.2040, 1.0570];
    let matrix: Vec<(i32, i32)> = XYZ_TO_SRGB.iter().map(|v| ((v * 10_000.0).round() as i32, 10_000)).collect();
    let mut fields = common(width, height, pixels.len(), 32803, 1, 16, 1); // CFA
    fields.extend([
        ascii(271, "Heeler"),
        ascii(272, "Test Mosaic"),
        shorts(33421, &[2, 2]),                      // CFARepeatPatternDim
        bytes(33422, &[0, 1, 1, 2]),                 // CFAPattern: RGGB
        bytes(50706, &[1, 4, 0, 0]),                 // DNGVersion
        bytes(50707, &[1, 1, 0, 0]),                 // DNGBackwardVersion
        ascii(50708, "Heeler Test Mosaic"),          // UniqueCameraModel
        bytes(50710, &[0, 1, 2]),                    // CFAPlaneColor
        shorts(50711, &[1]),                         // CFALayout: rectangular
        longs(50714, &[0]),                          // BlackLevel
        longs(50717, &[65535]),                      // WhiteLevel
        srationals(50721, &matrix),                  // ColorMatrix1
        rationals(50728, &[(1, 1), (1, 1), (1, 1)]), // AsShotNeutral
        shorts(50778, &[21]),                        // CalibrationIlluminant1: D65
    ]);
    write_tiff(&pixels, fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode_bytes;

    fn ramp(w: usize, h: usize, peak: f32) -> ImageBuf {
        let mut buf = ImageBuf::new(w, h);
        for i in 0..w * h {
            let t = i as f32 / (w * h - 1).max(1) as f32;
            buf.data[i * 4] = t * peak;
            buf.data[i * 4 + 1] = t * peak * 0.5;
            buf.data[i * 4 + 2] = t * peak * 0.25;
            buf.data[i * 4 + 3] = 1.0;
        }
        buf
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }
    fn u16_at(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap())
    }

    /// Every tag in the first directory, as (tag, kind, count, raw value).
    fn fields_of(bytes: &[u8]) -> Vec<(u16, u16, u32, u32)> {
        let ifd = u32_at(bytes, 4) as usize;
        let count = u16_at(bytes, ifd) as usize;
        (0..count)
            .map(|i| {
                let at = ifd + 2 + i * 12;
                (
                    u16_at(bytes, at),
                    u16_at(bytes, at + 2),
                    u32_at(bytes, at + 4),
                    u32_at(bytes, at + 8),
                )
            })
            .collect()
    }

    #[test]
    fn metadata_can_grow_the_job_instead_of_hitting_a_fixed_allowance() {
        heeler_engine::memory::with_budget(1 << 20, || {
            let _job = heeler_engine::memory::Job::admit(64 * 1024, "small export").unwrap();
            let text = "x".repeat(100_000);
            let out = heeler_engine::memory::catch(|| write_tiff(&[0u8; 6], vec![ascii(270, &text)])).unwrap();
            assert!(out.len() > 100_000);
        });
    }

    #[test]
    fn a_baked_tiff_reads_back_as_the_picture_that_went_in() {
        // The point of the exercise: it has to survive the round trip,
        // not merely be a well-formed file.
        let src = ramp(16, 9, 1.0);
        let file = encode_tiff16(&src).unwrap();
        let back = decode_bytes(&file).unwrap();
        assert_eq!((back.width, back.height), (16, 9));
        for i in 0..16 * 9 {
            for c in 0..3 {
                let (a, b) = (src.data[i * 4 + c], back.data[i * 4 + c]);
                assert!((a - b).abs() < 0.002, "pixel {i} channel {c}: {a} became {b}");
            }
        }
    }

    #[test]
    fn the_tiff_carries_the_srgb_profile_and_the_dng_does_not() {
        let tiff = encode_tiff16(&ramp(4, 4, 1.0)).unwrap();
        let icc = fields_of(&tiff).into_iter().find(|f| f.0 == 34675);
        let (_, kind, count, offset) = icc.expect("TIFF has InterColorProfile");
        assert_eq!(kind, 7, "UNDEFINED type per TIFF/EP");
        let payload = &tiff[offset as usize..offset as usize + count as usize];
        assert_eq!(payload, crate::icc::srgb_profile(), "exact profile bytes");
        // Scene-referred linear data must not claim to be display sRGB.
        let dng = encode_dng(&ramp(4, 4, 1.0), None).unwrap();
        assert!(fields_of(&dng).iter().all(|f| f.0 != 34675));
    }

    /// The directory leads the file: the size is readable from the first
    /// kilobyte, the strip ends the file, and nothing between them is
    /// lost on the way back.
    #[test]
    fn the_directory_leads_the_pixels() {
        let exif = crate::Exif { make: Some("NIKON".into()), model: Some("Z 7".into()), ..Default::default() };
        let src = ramp(16, 9, 1.0);
        let tiffs = [encode_tiff16(&src).unwrap(), encode_tiff16_export(&src, crate::TiffExportOptions { exif: Some(&exif), ..Default::default() }).unwrap()];
        let dng = encode_dng(&src, Some(&exif)).unwrap();
        for file in tiffs.iter().chain(std::iter::once(&dng)) {
            assert_eq!(u32_at(file, 4), 8, "the first directory sits right after the header");
            let fields = fields_of(file);
            let strip_at = fields.iter().find(|f| f.0 == 273).unwrap().3 as usize;
            let strip_len = fields.iter().find(|f| f.0 == 279).unwrap().3 as usize;
            assert!(strip_at >= 8 + 2 + fields.len() * 12 + 4, "the strip follows the directory");
            assert_eq!(strip_at + strip_len, file.len(), "the strip ends the file");
            assert_eq!(strip_at % 2, 0);
            assert_eq!(strip_len, 16 * 9 * 6, "three 16-bit samples per pixel");
        }
        // The two TIFFs encode the same picture the same way: the strips
        // agree byte for byte wherever the directory landed them.
        let strip = |file: &[u8]| {
            let at = fields_of(file).iter().find(|f| f.0 == 273).unwrap().3 as usize;
            file[at..].to_vec()
        };
        assert_eq!(strip(&tiffs[0]), strip(&tiffs[1]));
        for file in &tiffs {
            let back = decode_bytes(file).unwrap();
            assert_eq!((back.width, back.height), (16, 9));
            for i in 0..16 * 9 {
                assert!((src.data[i * 4] - back.data[i * 4]).abs() < 0.002);
            }
        }
        // And the size is there for a reader that stops after 1 KiB.
        assert_eq!(crate::source_dimensions(&tiffs[1][..1024]), Some((16, 9)));
    }

    /// The catalog's keywords go in as tag 700 at encode time, so the
    /// directory still leads the file. A packet spliced on afterwards
    /// must move the directory to grow it: measured on the old splice,
    /// the directory of a keyword export sat 318 bytes from the file's
    /// end and the header-only probe answered None.
    #[test]
    fn keywords_ride_the_leading_directory() {
        let exif = crate::Exif { make: Some("Canon".into()), ..Default::default() };
        let img = ramp(64, 48, 1.0);
        let xmp = crate::exif::xmp_keywords_packet(&["wedding".to_string(), "smith & sons".to_string()]);
        for file in [
            encode_tiff16_export(&img, crate::TiffExportOptions { exif: Some(&exif), xmp: Some(&xmp), ..Default::default() }).unwrap(),
            encode_dng_with_xmp(&img, Some(&exif), Some(&xmp)).unwrap(),
        ] {
            assert_eq!(u32_at(&file, 4), 8, "the directory still leads the file");
            let fields = fields_of(&file);
            let xmp_field = fields.iter().find(|f| f.0 == crate::exif::TAG_XMP).expect("tag 700 in IFD0");
            assert_eq!(xmp_field.1, BYTE, "tag 700 is a byte string, as readers expect");
            let packet = &file[xmp_field.3 as usize..xmp_field.3 as usize + xmp_field.2 as usize];
            assert_eq!(packet, xmp.as_bytes(), "the packet is there byte for byte");
            assert_eq!(crate::read_exif(&file).make.as_deref(), Some("Canon"), "the camera record survives");
        }
        let tiff = encode_tiff16_export(&img, crate::TiffExportOptions { exif: Some(&exif), xmp: Some(&xmp), ..Default::default() }).unwrap();
        assert!(decode_bytes(&tiff).is_ok(), "the picture survives");
        assert_eq!(crate::source_dimensions(&tiff[..1024]), Some((64, 48)), "a keyword export probes from the prefix");
    }

    /// TIFF's counts and offsets are 32-bit: a frame whose strip passes
    /// 4 GB is refused, not written with a truncated StripByteCounts.
    #[test]
    fn a_frame_past_4_gb_is_refused_rather_than_truncated() {
        assert_eq!(strip_len(715_827_882, 1).unwrap(), 4_294_967_292, "the largest strip the tag can say");
        let err = strip_len(715_827_883, 1).unwrap_err().to_string();
        assert!(err.contains("4 GB") && err.contains("BigTIFF"), "{err}");
        assert!(strip_len(30_000, 30_000).is_err(), "900 MP of 16-bit RGB is past the line");
        assert!(strip_len(26_000, 26_000).is_ok(), "676 MP still fits");
    }

    #[test]
    fn the_directory_is_in_tag_order() {
        // Readers are allowed to binary-search it, so an out-of-order tag
        // is a file that some decoders open and others do not.
        for file in [encode_tiff16(&ramp(4, 4, 1.0)).unwrap(), encode_dng(&ramp(4, 4, 1.0), None).unwrap()]
        {
            let tags: Vec<u16> = fields_of(&file).iter().map(|f| f.0).collect();
            let mut sorted = tags.clone();
            sorted.sort();
            assert_eq!(tags, sorted);
            assert_eq!(&file[..2], b"II");
            assert_eq!(u16_at(&file, 2), 42);
        }
    }

    #[test]
    fn the_export_tiff_carries_the_camera_record_and_reads_back() {
        let src = ramp(16, 9, 1.0);
        let exif = crate::Exif {
            make: Some("NIKON".into()),
            model: Some("Z 7".into()),
            iso: Some(64),
            shutter: Some(crate::exif::Ratio { num: 1, den: 250 }),
            aperture: Some(crate::exif::Ratio { num: 28, den: 10 }),
            shot_at: Some("2026:08:16 10:41:00".into()),
            ..Default::default()
        };
        let file = encode_tiff16_export(&src, crate::TiffExportOptions { exif: Some(&exif), ..Default::default() }).unwrap();

        // The picture survives, same bargain as the bake.
        let back = decode_bytes(&file).unwrap();
        assert_eq!((back.width, back.height), (16, 9));

        // The directory is in tag order, Exif pointer included.
        let tags: Vec<u16> = fields_of(&file).iter().map(|f| f.0).collect();
        let mut sorted = tags.clone();
        sorted.sort();
        assert_eq!(tags, sorted);

        // And the whole record parses straight back out of the file.
        let read = crate::read_exif(&file);
        assert_eq!(read.make.as_deref(), Some("NIKON"));
        assert_eq!(read.model.as_deref(), Some("Z 7"));
        assert_eq!(read.iso, Some(64));
        assert_eq!(read.shot_at.as_deref(), Some("2026:08:16 10:41:00"));
        assert_eq!(read.width, Some(16));
        assert_eq!(read.height, Some(9));
    }

    #[test]
    fn an_export_tiff_without_a_record_is_still_a_plain_tiff() {
        // No camera record, no Exif directory: the pointer is only
        // written when there is something to point at. The reader still
        // reports the dimensions (every TIFF has those), so "no record"
        // means no camera, not an empty answer.
        let file = encode_tiff16_export(&ramp(4, 4, 1.0), crate::TiffExportOptions { exif: None, ..Default::default() }).unwrap();
        assert!(fields_of(&file).iter().all(|f| f.0 != 34665));
        let read = crate::read_exif(&file);
        assert!(read.camera().is_none());
        assert_eq!(read.iso, None);
    }

    #[test]
    fn a_dng_says_it_is_one() {
        let file = encode_dng(&ramp(8, 8, 1.0), None).unwrap();
        let fields = fields_of(&file);
        let find = |tag: u16| fields.iter().find(|f| f.0 == tag).copied();
        // Without DNGVersion it is just a TIFF nobody can interpret.
        let version = find(50706).expect("DNGVersion");
        assert_eq!(version.1, BYTE);
        assert_eq!(version.3.to_le_bytes(), [1, 4, 0, 0]);
        // LinearRaw, because the frames were demosaiced long before they
        // were merged and there is no CFA pattern left to declare.
        assert_eq!(find(262).unwrap().3, 34892);
        assert_eq!(find(50717).unwrap().3, 65535, "WhiteLevel");
        assert_eq!(find(50714).unwrap().3, 0, "BlackLevel");
        assert_eq!(find(50778).unwrap().3, 21, "CalibrationIlluminant1 should be D65");
        assert!(find(50721).is_some(), "ColorMatrix1");
        assert!(find(50728).is_some(), "AsShotNeutral");
        assert_eq!(find(256).unwrap().3, 8);
        assert_eq!(find(257).unwrap().3, 8);
    }

    #[test]
    fn highlights_past_white_are_kept_rather_than_clipped() {
        // The entire reason DNG is the default. A merge holds a sky two
        // or three stops over scene white; a format that clips it has
        // thrown away the thing the merge was made for.
        let (scale, stops) = linear_headroom(&ramp(8, 8, 4.0));
        assert!((scale - 4.0).abs() < 1e-4);
        assert!((stops - 2.0).abs() < 1e-4, "four times over white is two stops");

        let file = encode_dng(&ramp(8, 8, 4.0), None).unwrap();
        // The brightest red is the last pixel, and it must land at the
        // top of the range rather than having been flattened into it.
        let last = 8 * 8 - 1;
        let strip = fields_of(&file).iter().find(|f| f.0 == 273).unwrap().3 as usize;
        let top = u16_at(&file, strip + last * 6);
        assert_eq!(top, 65535);
        // And the pixel at a quarter of the peak is a quarter of the way
        // up, which is what makes it linear and what makes the exposure
        // offset able to undo it.
        let quarter = u16_at(&file, strip + (last / 4) * 6);
        assert!(
            (quarter as f32 / 65535.0 - 0.25).abs() < 0.02,
            "expected a linear ramp, got {quarter}",
        );
    }

    #[test]
    fn a_frame_that_never_goes_over_white_is_left_alone() {
        // Scaling it anyway would give every baked file a different
        // exposure for no reason at all.
        let (scale, stops) = linear_headroom(&ramp(8, 8, 1.0));
        assert_eq!(scale, 1.0);
        assert_eq!(stops, 0.0);
        // And a frame of nothing but zeroes must not divide by anything.
        let (scale, _) = linear_headroom(&ImageBuf::new(4, 4));
        assert_eq!(scale, 1.0);
    }

    #[test]
    fn the_exposure_offset_survives_the_round_trip() {
        // Otherwise baking a merge and opening it again gives you a
        // darker picture than the one you baked, which is the first
        // thing anybody would notice.
        let file = encode_dng(&ramp(8, 8, 4.0), None).unwrap();
        let stops = baked_exposure(&file).expect("our own file should be recognized");
        assert!((stops - 2.0).abs() < 1e-3);
        // And a frame that needed no headroom reports none.
        let flat = encode_dng(&ramp(8, 8, 1.0), None).unwrap();
        assert_eq!(baked_exposure(&flat), Some(0.0));
    }

    #[test]
    fn someone_elses_dng_is_left_alone() {
        // A camera DNG carries a BaselineExposure of its own, which
        // this path leaves alone: only a bake's offset is put back.
        let mut file = encode_dng(&ramp(8, 8, 4.0), None).unwrap();
        let model = file
            .windows(BAKE_CAMERA_MODEL.len())
            .position(|w| w == BAKE_CAMERA_MODEL.as_bytes())
            .expect("the marker is in there");
        file[model] = b'N';
        assert_eq!(baked_exposure(&file), None);
        // And nothing that is not a TIFF at all.
        assert_eq!(baked_exposure(b"not an image"), None);
        assert_eq!(baked_exposure(&[]), None);
    }

    #[test]
    fn an_empty_frame_is_refused_rather_than_written() {
        assert!(encode_tiff16(&ImageBuf::new(0, 0)).is_err());
        assert!(encode_dng(&ImageBuf::new(0, 0), None).is_err());
    }

    #[test]
    fn the_dng_keeps_the_camera_record_when_one_is_handed_in() {
        // The export panel's Metadata switch promises "camera, lens and
        // exposure ride along in the file", and the DNG was the one
        // format where that promise was not kept: the writer stamped
        // "Heeler"/"Bake" and stopped. A file headed into another
        // editor is exactly where the record matters; lens profiles
        // read it.
        let exif = crate::Exif {
            make: Some("Panasonic".into()),
            model: Some("DC-S5".into()),
            lens: Some("LUMIX S PRO 24-70mm".into()),
            iso: Some(400),
            ..Default::default()
        };
        let file = encode_dng(&ramp(8, 8, 1.0), Some(&exif)).unwrap();
        let read = crate::read_exif(&file);
        assert_eq!(read.make.as_deref(), Some("Panasonic"));
        assert_eq!(read.model.as_deref(), Some("DC-S5"));
        assert_eq!(read.iso, Some(400));

        // The three IFD0 strings the record can also carry. Separate
        // from make/model above, which take over tags the bake already
        // wrote; these are pushed only when present, and none of them
        // appears in common(), so the directory cannot gain a duplicate
        // tag (write_tiff debug-asserts that it does not).
        let dated = crate::Exif {
            make: Some("Panasonic".into()),
            shot_at: Some("2026:08:28 11:04:00".into()),
            artist: Some("A. Photographer".into()),
            copyright: Some("(c) 2026".into()),
            ..Default::default()
        };
        let file = encode_dng(&ramp(8, 8, 1.0), Some(&dated)).unwrap();
        let tags: Vec<u16> = fields_of(&file).iter().map(|f| f.0).collect();
        let mut sorted = tags.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(tags, sorted, "in tag order, no duplicates");
        let read = crate::read_exif(&file);
        assert_eq!(read.shot_at.as_deref(), Some("2026:08:28 11:04:00"));
        assert_eq!(read.artist.as_deref(), Some("A. Photographer"));
        assert_eq!(read.copyright.as_deref(), Some("(c) 2026"));

        // None is the bake's call, and the bake's file is unchanged: no
        // Exif pointer, the same Heeler/Bake stamps it always had, and
        // no shooting details.
        let plain = encode_dng(&ramp(8, 8, 1.0), None).unwrap();
        assert!(fields_of(&plain).iter().all(|f| f.0 != 34665));
        let plain_read = crate::read_exif(&plain);
        assert_eq!(plain_read.make.as_deref(), Some("Heeler"));
        assert_eq!(plain_read.model.as_deref(), Some("Bake"));
        assert_eq!(plain_read.iso, None);
    }

    /// 26.3 Phase 3a: a Transparent TIFF was silently opaque, the writer
    /// dropping the alpha the export gate had promised. A buffer with
    /// alpha below 1 now writes a fourth sample and a reader gets it back.
    #[test]
    fn a_tiff_with_transparency_keeps_its_alpha() {
        // Payloads to four bytes live INLINE in the directory entry
        // (write_tiff left-aligns them), so a scalar SHORT or LONG reads
        // from the raw field itself, not from where it points.
        let scalar = |fields: &[(u16, u16, u32, u32)], tag: u16| {
            fields.iter().find(|f| f.0 == tag).map(|f| if f.1 == SHORT { f.3 & 0xFFFF } else { f.3 })
        };
        let mut buf = ramp(8, 4, 1.0);
        for i in 0..8 * 4 {
            buf.data[i * 4 + 3] = if i % 2 == 0 { 0.5 } else { 1.0 };
        }
        for file in [encode_tiff16(&buf).unwrap(), encode_tiff16_export(&buf, crate::TiffExportOptions { exif: None, ..Default::default() }).unwrap()] {
            // The directory says four samples and unassociated alpha.
            let fields = fields_of(&file);
            assert_eq!(scalar(&fields, 277), Some(4), "SamplesPerPixel");
            assert_eq!(scalar(&fields, 338), Some(2), "ExtraSamples: unassociated alpha");
            // The image crate reads it back with the alpha intact: half
            // transparent in, half transparent out.
            let back = image::load_from_memory(&file).unwrap().to_rgba16();
            for i in 0..8 * 4 {
                let a = back.as_raw()[i * 4 + 3];
                let want = if i % 2 == 0 { 32768 } else { 65535 };
                assert!((a as i32 - want).abs() <= 1, "pixel {i}: alpha {a}, wanted {want}");
            }
        }
        // An opaque buffer still writes three samples: readers that
        // premultiply on sight of alpha never see one.
        let opaque = encode_tiff16(&ramp(8, 4, 1.0)).unwrap();
        let fields = fields_of(&opaque);
        assert!(fields.iter().all(|f| f.0 != 338));
        assert_eq!(scalar(&fields, 277), Some(3));
        assert_eq!(scalar(&fields, 279), Some((8 * 4 * 6) as u32), "three 16-bit samples a pixel");
    }

    /// 26.3 Phase 3b: the float TIFF keeps the scene-linear numbers as
    /// they are, no curve, no clamp, no profile.
    #[test]
    fn the_float_tiff_is_the_linear_numbers_undisturbed() {
        let mut buf = ImageBuf::new(4, 2);
        for i in 0..8 {
            buf.data[i * 4] = 2.5 + i as f32 * 0.25; // above scene white: kept
            buf.data[i * 4 + 1] = -0.5; // below black: kept
            buf.data[i * 4 + 2] = 0.25;
            buf.data[i * 4 + 3] = 1.0;
        }
        let file = encode_tiff32f(&buf, crate::FloatTiffOptions { include_alpha: false, dpi: None }).unwrap();
        let fields = fields_of(&file);
        // SHORT lists longer than four bytes sit out of line, the raw
        // field their offset; scalar SHORTs and LONGs read inline.
        let short_list = |tag: u16| {
            let offset = fields.iter().find(|f| f.0 == tag).unwrap().3 as usize;
            u16_at(&file, offset)
        };
        let scalar = |tag: u16| fields.iter().find(|f| f.0 == tag).map(|f| if f.1 == SHORT { f.3 & 0xFFFF } else { f.3 });
        assert_eq!(short_list(258), 32, "BitsPerSample");
        assert_eq!(short_list(339), 3, "SampleFormat: IEEE float");
        assert_eq!(scalar(277), Some(3), "SamplesPerPixel");
        assert!(fields.iter().all(|f| f.0 != 34675), "no ICC on a linear file");
        let strip_at = scalar(273).unwrap() as usize;
        for i in 0..8 {
            let r = f32::from_le_bytes(file[strip_at + i * 12..strip_at + i * 12 + 4].try_into().unwrap());
            let g = f32::from_le_bytes(file[strip_at + i * 12 + 4..strip_at + i * 12 + 8].try_into().unwrap());
            assert_eq!(r, buf.data[i * 4], "pixel {i} red, unclamped");
            assert_eq!(g, -0.5, "pixel {i} green, unclamped");
        }
        // The description says what the numbers mean.
        let desc = fields.iter().find(|f| f.0 == 270).unwrap();
        let text = std::str::from_utf8(&file[desc.3 as usize..desc.3 as usize + desc.2 as usize]).unwrap();
        assert!(text.contains("Linear Rec.709"), "{text}");
        // With alpha, a fourth float sample.
        let mut rgba = ImageBuf::new(4, 2);
        rgba.data.clone_from_slice(&buf.data);
        rgba.data[3] = 0.25;
        let file = encode_tiff32f(&rgba, crate::FloatTiffOptions { include_alpha: true, dpi: None }).unwrap();
        let fields = fields_of(&file);
        assert_eq!(fields.iter().find(|f| f.0 == 277).map(|f| f.3 & 0xFFFF), Some(4));
        let strip_at = fields.iter().find(|f| f.0 == 273).unwrap().3 as usize;
        let a0 = f32::from_le_bytes(file[strip_at + 12..strip_at + 16].try_into().unwrap());
        assert_eq!(a0, 0.25);
    }

    /// 26.3 Phase 7: a Finish layer's TIFF sibling is always RGBA, even
    /// when the layer is opaque, and its mode and opacity ride the
    /// description tag.
    #[test]
    fn a_finish_layer_tiff_is_always_rgba_with_its_record_in_the_description() {
        let src = ramp(8, 4, 1.0);
        let file = encode_tiff16_layer(&src, "Heeler Finish layer 'Paint 1'; mode soft_light; opacity 80", None).unwrap();
        let fields = fields_of(&file);
        assert_eq!(fields.iter().find(|f| f.0 == 277).map(|f| f.3 & 0xFFFF), Some(4), "four samples even when opaque");
        assert_eq!(fields.iter().find(|f| f.0 == 338).map(|f| f.3 & 0xFFFF), Some(2), "ExtraSamples: unassociated alpha");
        let desc = fields.iter().find(|f| f.0 == 270).unwrap();
        let text = std::str::from_utf8(&file[desc.3 as usize..desc.3 as usize + desc.2 as usize]).unwrap();
        assert!(text.contains("mode soft_light"), "{text}");
        let back = decode_bytes(&file).unwrap();
        assert_eq!((back.width, back.height), (8, 4));
        assert_eq!(back.data[3], 1.0, "opaque alpha survives the round trip");
    }

    #[test]
    fn a_finish_layer_float_tiff_is_rgba_float_with_the_description() {
        let src = ramp(4, 2, 0.5);
        let file = encode_tiff32f_layer(&src, "Heeler Finish layer 'Grad'; mode normal; opacity 100; linear colors", None).unwrap();
        let fields = fields_of(&file);
        assert_eq!(fields.iter().find(|f| f.0 == 277).map(|f| f.3 & 0xFFFF), Some(4));
        // SampleFormat, four SHORTs (IEEE float), past the inline size
        // so the field carries the offset.
        let fmt = fields.iter().find(|f| f.0 == 339).unwrap();
        assert_eq!(fmt.2, 4);
        let at = fmt.3 as usize;
        assert!(file[at..at + 8].chunks_exact(2).all(|s| s == [3, 0]), "IEEE float samples");
        let desc = fields.iter().find(|f| f.0 == 270).unwrap();
        let text = std::str::from_utf8(&file[desc.3 as usize..desc.3 as usize + desc.2 as usize]).unwrap();
        assert!(text.contains("Grad"), "{text}");
    }

    /// 26.3 Phase 8: a Finish layer is already display-referred, so its
    /// 16-bit sibling writes the numbers as they are - applying the
    /// sRGB curve again would lift every midtone.
    #[test]
    fn a_display_referred_layer_tiff_skips_the_curve() {
        let mut src = ImageBuf::new(2, 1);
        src.set_pixel(0, 0, [0.5, 0.25, 0.75, 0.5]);
        src.set_pixel(1, 0, [0.1, 0.2, 0.3, 1.0]);
        let file = encode_tiff16_layer_display(&src, "Heeler Finish layer 'Paint 1'; mode normal; opacity 100", None).unwrap();
        let fields = fields_of(&file);
        assert_eq!(fields.iter().find(|f| f.0 == 277).map(|f| f.3 & 0xFFFF), Some(4));
        let strip_at = fields.iter().find(|f| f.0 == 273).unwrap().3 as usize;
        let sample = |i: usize| u16::from_le_bytes(file[strip_at + i * 2..strip_at + i * 2 + 2].try_into().unwrap()) as f32 / 65535.0;
        assert!((sample(0) - 0.5).abs() < 0.0001, "red as-is: {}", sample(0));
        assert!((sample(3) - 0.5).abs() < 0.0001, "alpha as-is: {}", sample(3));
        // The same numbers through encode_tiff16_layer would come out
        // brighter; guard the difference so the two never drift into
        // each other.
        let curved = encode_tiff16_layer(&src, "x", None).unwrap();
        let cfields = fields_of(&curved);
        let cat = cfields.iter().find(|f| f.0 == 273).unwrap().3 as usize;
        let cs = u16::from_le_bytes(curved[cat..cat + 2].try_into().unwrap()) as f32 / 65535.0;
        assert!(cs > 0.7, "the curved writer lifts 0.5 to sRGB: {cs}");
    }
}
