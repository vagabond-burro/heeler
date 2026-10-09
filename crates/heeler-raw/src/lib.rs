//! Minimal safe wrapper over LibRaw's C API (vendored, CDDL-1.0 option).
//!
//! One entry point: [`decode_sensor`] takes RAW bytes and returns
//! demosaiced, scene-linear 16-bit RGB in sRGB primaries (gamma 1.0, no
//! auto-brighten), which maps directly onto Heeler's working space.

use std::ffi::{c_char, c_int, c_uint, c_void, CStr};

// Linked, not called. LibRaw's deflate DNG decoder calls zlib from C++,
// and Rust drops a dependency nothing in Rust refers to, so the symbols
// went missing at link time even though the library was built. This is
// the reference that keeps it.
use libz_sys as _;
use mozjpeg_sys as _;

/// The vendored LibRaw this binary actually compiled.
///
/// A license fact as much as a build fact: CDDL-1.0 obliges us to offer
/// THIS source to anyone holding the binary, so the user-facing notice
/// has to name it and a test holds the two together.
pub const LIBRAW_VERSION: &str = env!("HEELER_RAW_LIBRAW_VERSION");

/// Whether libjpeg made it into the build, which is whether lossy DNG
/// decodes. See [`ZLIB_LINKED`] for why these are worth stating out loud.
pub const JPEG_LINKED: bool = matches!(env!("HEELER_RAW_JPEG").as_bytes(), b"1");

/// Whether zlib made it into the build, which is whether deflate DNG
/// (a RAW editor's HDR Merge) decodes.
///
/// Both flags are exported rather than merely asserted in tests because
/// they are the pair that lied: USE_JPEG was once applied after
/// `compile()`, so the define never reached the compiler while this
/// probe went on reporting a decoder that was not there. A build-time
/// claim is worth exactly as much as the file that tests it, which is
/// what `examples/dngprobe.rs` prints them next to.
pub const ZLIB_LINKED: bool = matches!(env!("HEELER_RAW_ZLIB").as_bytes(), b"1");

#[derive(Debug, thiserror::Error)]
pub enum RawError {
    #[error("{0}")]
    Memory(#[from] heeler_engine::memory::MemoryError),
    #[error("libraw init failed")]
    Init,
    #[error("libraw: {0} ({1})")]
    Code(String, c_int),
    #[error("libraw produced an unexpected image format")]
    Unexpected,
}

/// Mirrors libraw_processed_image_t.
#[repr(C)]
struct ProcessedImage {
    image_type: c_int, // 1 = JPEG, 2 = bitmap
    height: u16,
    width: u16,
    colors: u16,
    bits: u16,
    data_size: c_uint,
    data: [u8; 1],
}

extern "C" {
    fn libraw_init(flags: c_uint) -> *mut c_void;
    fn libraw_close(d: *mut c_void);
    fn libraw_open_buffer(d: *mut c_void, buf: *const c_void, size: usize) -> c_int;
    fn libraw_unpack(d: *mut c_void) -> c_int;
    fn libraw_dcraw_process(d: *mut c_void) -> c_int;
    fn libraw_dcraw_make_mem_image(d: *mut c_void, errc: *mut c_int) -> *mut ProcessedImage;
    fn libraw_dcraw_clear_mem(p: *mut ProcessedImage);
    fn libraw_strerror(err: c_int) -> *const c_char;
    fn libraw_set_output_bps(d: *mut c_void, value: c_int);
    fn libraw_set_output_color(d: *mut c_void, value: c_int);
    fn libraw_set_no_auto_bright(d: *mut c_void, value: c_int);
    fn libraw_set_gamma(d: *mut c_void, index: c_int, value: f32);
    // Shim (src/shim.cpp) over internals the C API does not expose.
    fn heeler_raw_width(d: *mut c_void) -> u32;
    fn heeler_raw_height(d: *mut c_void) -> u32;
    fn heeler_set_half_size(d: *mut c_void, value: c_int);
    fn heeler_set_fixed_white(d: *mut c_void, value: c_int);
    fn heeler_set_use_camera_wb(d: *mut c_void, value: c_int);
    fn heeler_set_use_camera_matrix(d: *mut c_void, value: c_int);
    fn heeler_set_highlight(d: *mut c_void, value: c_int);
    fn heeler_wb_headroom(d: *mut c_void) -> f32;
    fn heeler_set_user_qual(d: *mut c_void, value: c_int);
    fn heeler_silence_data_errors(d: *mut c_void);
    fn heeler_is_sensor_data(d: *mut c_void) -> c_int;
}

/// Develop knobs the UI exposes on the source node.
#[derive(Debug, Clone, Copy)]
pub struct DevelopOpts {
    /// Half-resolution demosaic for previews (~4x faster).
    pub half_size: bool,
    /// Keep the declared white level rather than scaling by this frame's
    /// brightest sample. Scene-linear stack ratios need fixed units.
    pub fixed_white: bool,
    /// As-shot white balance from the camera's metering.
    pub camera_wb: bool,
    /// The camera's embedded color matrix; off uses LibRaw's adobe_coeff table.
    pub camera_matrix: bool,
    /// LibRaw highlight handling: 0 clip, 2 blend, 3..9 rebuild. Mode
    /// 1 (unclipped) is deliberately not offered; see the shim's note.
    pub highlight: i32,
    /// LibRaw demosaic (user_qual): -1 default, 0 linear, 11 DHT.
    pub demosaic: i32,
}

impl Default for DevelopOpts {
    fn default() -> Self {
        DevelopOpts { half_size: false, fixed_white: false, camera_wb: true, camera_matrix: true, highlight: 0, demosaic: -1 }
    }
}

struct Handle(*mut c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe { libraw_close(self.0) }
    }
}

fn check(code: c_int) -> Result<(), RawError> {
    if code == 0 {
        return Ok(());
    }
    let msg = unsafe {
        let p = libraw_strerror(code);
        if p.is_null() {
            "unknown".to_string()
        } else {
            CStr::from_ptr(p).to_string_lossy().into_owned()
        }
    };
    Err(RawError::Code(msg, code))
}

impl std::fmt::Debug for SensorImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SensorImage({}x{}, {} samples)", self.width, self.height, self.rgb.len())
    }
}

pub struct SensorImage {
    pub width: usize,
    pub height: usize,
    /// Interleaved RGB, 16 bits per channel, linear (gamma 1.0), sRGB
    /// primaries, no auto-brightening.
    pub rgb: Vec<u16>,
    /// The white-balance headroom LibRaw withheld when highlight
    /// reconstruction ran (1.0 otherwise). The f32 conversion
    /// multiplies it back so switching reconstruction modes never
    /// reads as an exposure change, and reconstructed super-whites
    /// land above 1.0 in scene-linear, where the tone profile's
    /// shoulder knows what to do with them.
    pub headroom: f32,
    /// Sensor data the develop interpolated (a Bayer or X-Trans mosaic,
    /// or a monochrome sensor), as opposed to a linear DNG whose pixels
    /// some program already developed. Capture sharpening belongs to
    /// the first and never to the second.
    pub sensor_data: bool,
}

/// Export-quality decode: full-resolution demosaic, camera WB and matrix.
pub fn decode_sensor(bytes: &[u8]) -> Result<SensorImage, RawError> {
    decode_sensor_with(bytes, DevelopOpts::default())
}

/// Preview-speed decode: half-resolution demosaic (~4x faster), plenty
/// for on-screen previews that get downscaled anyway.
pub fn decode_sensor_half(bytes: &[u8]) -> Result<SensorImage, RawError> {
    decode_sensor_with(bytes, DevelopOpts { half_size: true, ..DevelopOpts::default() })
}

/// Header identification only: LibRaw has not unpacked sensor pixels yet.
pub fn dimensions(bytes: &[u8]) -> Result<(usize, usize), RawError> {
    let p = unsafe { libraw_init(0) };
    if p.is_null() { return Err(RawError::Init); }
    let handle = Handle(p);
    check(unsafe { libraw_open_buffer(handle.0, bytes.as_ptr() as *const c_void, bytes.len()) })?;
    Ok(unsafe { (heeler_raw_width(handle.0) as usize, heeler_raw_height(handle.0) as usize) })
}

pub fn decode_sensor_with(bytes: &[u8], opts: DevelopOpts) -> Result<SensorImage, RawError> {
    let handle = {
        let p = unsafe { libraw_init(0) };
        if p.is_null() {
            return Err(RawError::Init);
        }
        Handle(p)
    };
    unsafe {
        libraw_set_output_bps(handle.0, 16);
        libraw_set_output_color(handle.0, 1); // sRGB primaries
        libraw_set_no_auto_bright(handle.0, 1);
        libraw_set_gamma(handle.0, 0, 1.0); // linear transfer
        libraw_set_gamma(handle.0, 1, 1.0);
        heeler_set_half_size(handle.0, opts.half_size as c_int);
        heeler_set_fixed_white(handle.0, opts.fixed_white as c_int);
        // Without camera WB every develop renders green/cold, since
        // LibRaw's default multipliers ignore the camera's metering; both
        // camera hints are user-toggleable on the source node.
        heeler_set_use_camera_wb(handle.0, opts.camera_wb as c_int);
        heeler_set_use_camera_matrix(handle.0, opts.camera_matrix as c_int);
        heeler_set_highlight(handle.0, opts.highlight.clamp(0, 9) as c_int);
        heeler_set_user_qual(handle.0, opts.demosaic.clamp(-1, 12) as c_int);
        // Recoverable data warnings (e.g. every Panasonic S5 II file) went
        // to stderr by default, reading like hard failures in dev logs.
        heeler_silence_data_errors(handle.0);
    }
    check(unsafe { libraw_open_buffer(handle.0, bytes.as_ptr() as *const c_void, bytes.len()) })?;
    let (width, height) = unsafe { (heeler_raw_width(handle.0) as usize, heeler_raw_height(handle.0) as usize) };
    if width == 0 || height == 0 { return Err(RawError::Unexpected); }
    let sensor_data = unsafe { heeler_is_sensor_data(handle.0) } != 0;
    // Sensor, demosaic workspace, native processed RGB, Rust RGB and RGBA.
    // The sensor workspace remains full size even for a half-size develop.
    let needed = heeler_engine::memory::sum([heeler_engine::memory::bytes(width, height, 1, if opts.half_size { 24 } else { 48 })?, bytes.len()])?;
    let _job = heeler_engine::memory::Job::admit(needed, "RAW decode and demosaic")?;
    check(unsafe { libraw_unpack(handle.0) })?;
    check(unsafe { libraw_dcraw_process(handle.0) })?;
    let headroom = if opts.highlight >= 2 { unsafe { heeler_wb_headroom(handle.0) } } else { 1.0 };

    let mut errc: c_int = 0;
    let img = unsafe { libraw_dcraw_make_mem_image(handle.0, &mut errc) };
    if img.is_null() {
        check(errc)?;
        return Err(RawError::Unexpected);
    }
    let result = (|| unsafe {
        let r = &*img;
        // Monochrome sensors (Leica M Monochrom, Pentax K-3 III Monochrome)
        // and grayscale scanner DNGs come back with one channel, not three;
        // LibRaw has no switch to widen them. Before 2026-09-08 that was
        // rejected as Unexpected, and the app then showed the file's
        // preview or, with none, the 320-pixel thumbnail the TIFF reader
        // found in IFD0. Widening here keeps every caller on RGB.
        if r.image_type != 2 || r.bits != 16 || !(r.colors == 3 || r.colors == 1) {
            Err(RawError::Unexpected)
        } else {
            let (w, h) = (r.width as usize, r.height as usize);
            let channels = r.colors as usize;
            let samples = heeler_engine::memory::bytes(w, h, channels, 2)? / 2;
            if samples.checked_mul(2) != Some(r.data_size as usize) { return Err(RawError::Unexpected); }
            let data = std::slice::from_raw_parts(r.data.as_ptr() as *const u16, samples);
            let expected = heeler_engine::memory::bytes(w, h, 3, 2)? / 2;
            let mut rgb = heeler_engine::memory::vector(expected, 0u16, "RAW samples")?;
            if channels == 3 {
                rgb.copy_from_slice(data);
            } else {
                for (px, v) in rgb.chunks_exact_mut(3).zip(data) {
                    px.fill(*v);
                }
            }
            Ok(SensorImage {
                width: w,
                height: h,
                rgb,
                headroom,
                sensor_data,
            })
        }
    })();
    unsafe { libraw_dcraw_clear_mem(img) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn garbage_bytes_error_cleanly_without_crashing() {
        let junk = vec![0xA5u8; 64 * 1024];
        match decode_sensor(&junk) {
            Err(RawError::Code(_, _)) => {}
            other => panic!("expected a libraw error code, got {other:?}"),
        }
    }

    /// The license page names the LibRaw we actually build.
    ///
    /// LibRaw is used under CDDL-1.0, which obliges us to make THIS
    /// source available to anyone we hand a binary to. So the version
    /// on the page users read is a legal citation, and a citation that
    /// drifts is worse than none: it points confidently at a tree that
    /// does not exist.
    ///
    /// It has drifted before. The build moved to 0.22.2 and the license
    /// note in Cargo.toml went on naming 0.21.3, which is exactly the
    /// file somebody checking our compliance would open first. The
    /// version now lives in build.rs alone, and this holds the page to
    /// it: bump one without the other and the suite says so.
    #[test]
    fn the_licence_page_names_the_libraw_that_is_actually_built() {
        let version = LIBRAW_VERSION;
        let page = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/user-guide/legal/open-source.md");
        let raw = std::fs::read_to_string(&page)
            .unwrap_or_else(|e| panic!("the open-source notice is missing: {e}"));
        // Whitespace-normalized, because the requirements here are
        // about words and a markdown file is free to rewrap them. A
        // test that broke on a reflowed paragraph would be retired the
        // first time it cried wolf, and this one is worth keeping.
        let text = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            text.contains(&format!("LibRaw {version}")),
            "the notice does not name LibRaw {version}, which is the version this build compiles"
        );
        // And the tree it cites is the one on disk, with its license
        // text beside it. The archive script publishes exactly this.
        let tree = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(format!("../../third_party/LibRaw-{version}"));
        let licence = tree.join("LICENSE.CDDL");
        assert!(licence.is_file(), "no LICENSE.CDDL in {}", tree.display());

        // The license text is IN the app, not merely linked from it.
        // The obligation is to carry it with the software it covers,
        // and a pointer at a download somebody has to fetch is not the
        // same as having it. Compared word for word against the tree we
        // build, because a license quoted loosely is a license
        // misquoted: the page is generated and must never be
        // hand-edited.
        let shipped = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/user-guide/legal/cddl.md"),
        )
        .unwrap_or_else(|e| panic!("the CDDL page is missing from the shipped docs: {e}"));
        let words = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
        assert!(
            words(&shipped).contains(&words(&std::fs::read_to_string(&licence).unwrap())),
            "the CDDL page has drifted from the license in the source we build"
        );
        // The obligation is source availability, so the page has to say
        // where. A notice that names the license and not the place is
        // half a compliance.
        assert!(
            text.contains("CDDL") && text.contains("https://"),
            "the notice must name the license AND where the source is published"
        );
        // The IJG license asks for this sentence in these words, so it
        // is not paraphrasable and not optional while mozjpeg is linked.
        assert!(
            text.contains("based in part on the work of the Independent JPEG Group"),
            "the IJG acknowledgment is missing, and it is required verbatim"
        );
        // CDDL-1.0 lets us license our own binary on our own terms only
        // while it is clear those terms are ours alone and do not touch
        // the rights the CDDL grants over its source.
        assert!(
            text.contains("by Heeler alone"),
            "the notice must say whose warranty and support terms these are"
        );
    }

    #[test]
    fn deflate_compressed_dng_is_built_in() {
        // USE_ZLIB gates deflate_dng_load_raw, which is what a
        // floating-point DNG needs, which is what a RAW editor's HDR Merge
        // writes. Without it the build still succeeds and the decoder is
        // a no-op, so the only symptom is a whole class of file failing to
        // open with no explanation. Pinned here so it cannot switch off
        // quietly again.
        assert!(ZLIB_LINKED, "zlib is not linked, so deflate-compressed DNG will not decode");
    }

    #[test]
    fn lossy_dng_is_built_in() {
        // USE_JPEG gates jpeg_src, which returns -1 without it, leaving
        // the lossy DNG path nothing to read through. A RAW editor's Lossy
        // export writes these, and so do a good many drones and phones.
        assert!(JPEG_LINKED, "libjpeg is not linked, so lossy DNG will not decode");
    }

    #[test]
    fn empty_buffer_errors() {
        assert!(decode_sensor(&[]).is_err());
    }

    /// Real-file smoke test, opt-in because RAW fixtures are large:
    /// set HEELER_RAW_FIXTURE=path\to\file.nef and run.
    #[test]
    fn env_fixture_decodes_if_provided() {
        let Ok(path) = std::env::var("HEELER_RAW_FIXTURE") else {
            eprintln!("HEELER_RAW_FIXTURE not set; skipping");
            return;
        };
        let bytes = std::fs::read(&path).expect("fixture readable");
        let img = decode_sensor(&bytes).expect("fixture decodes");
        assert!(img.width > 100 && img.height > 100);
        assert_eq!(img.rgb.len(), img.width * img.height * 3);
        eprintln!("decoded {} at {}x{}", path, img.width, img.height);
    }
}
