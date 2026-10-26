//! RAW files developed to scene-linear 16-bit RGB in sRGB primaries
//! (gamma 1.0, no auto-brighten), which maps directly onto Heeler's
//! working space: [`decode_sensor`] and its variants.
//!
//! The develop is heeler-rawdec's, in Rust. With the libraw feature
//! (on by default, for the tests and harnesses) LibRaw is built too
//! (libraw.rs): the reference the Rust develop is held to, and with the
//! rust-decoder feature the develop of files the Rust path was not
//! verified on. The shipped app builds without it (rust_only.rs): every
//! file goes to heeler-rawdec, and one it declines is not opened.

#[cfg(not(any(feature = "libraw", feature = "rust-decoder")))]
compile_error!("heeler-raw needs the libraw feature, the rust-decoder feature, or both");

mod gpr;
pub mod linear_dng;
#[cfg(feature = "rust-decoder")]
pub mod rust_path;
#[cfg(feature = "libraw")]
mod libraw;
#[cfg(feature = "libraw")]
pub use libraw::*;
#[cfg(not(feature = "libraw"))]
mod rust_only;
#[cfg(not(feature = "libraw"))]
pub use rust_only::*;
pub use gpr::is_gpr;

/// Whether LibRaw is built in (the libraw feature: the tests and
/// harnesses, never the shipped app), which then answers for a file the
/// Rust develop declines.
pub const LIBRAW_BUILT: bool = cfg!(feature = "libraw");

/// A GoPro GPR as the copy LibRaw reads (its VC-5 tile decoded), or None
/// for any other file: for the harnesses that hold the Rust develop to
/// LibRaw's.
#[doc(hidden)]
pub fn gpr_as_dng(bytes: &[u8]) -> Result<Option<Vec<u8>>, RawError> {
    gpr::as_dng(bytes)
}

#[derive(Debug, thiserror::Error)]
pub enum RawError {
    #[error("{0}")]
    Memory(#[from] heeler_engine::memory::MemoryError),
    #[error("libraw init failed")]
    Init,
    #[error("libraw: {0} ({1})")]
    Code(String, std::ffi::c_int),
    #[error("libraw produced an unexpected image format")]
    Unexpected,
    /// A develop stopped by its caller (decode_sensor_until) between
    /// LibRaw's stages.
    #[error("RAW develop canceled")]
    Cancelled,
    /// A GoPro GPR that could not be decoded, said as such rather than as
    /// a LibRaw code: the failure is in the file or its VC-5 tile, before
    /// LibRaw sees anything.
    #[error("GoPro GPR: {0}")]
    Gpr(String),
    /// A file the Rust develop does not open (built without LibRaw, the
    /// shipped app): its format, or this variant of it, is not supported.
    #[error("this RAW file is not supported ({0})")]
    Unsupported(String),
    /// A file the Rust develop found damaged.
    #[error("damaged RAW data: {0}")]
    Damaged(String),
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
    /// The camera's calibration; off uses the generic one.
    pub camera_matrix: bool,
    /// Highlight handling: 0 clip, 2 blend. LibRaw's rebuild modes (3 to
    /// 9) exist only with the libraw feature; without it they develop as
    /// clip.
    pub highlight: i32,
    /// LibRaw's demosaic (user_qual): -1 the default, 0 linear, 11 DHT.
    /// Without the libraw feature every develop takes the default.
    pub demosaic: i32,
}

impl Default for DevelopOpts {
    fn default() -> Self {
        DevelopOpts { half_size: false, fixed_white: false, camera_wb: true, camera_matrix: true, highlight: 0, demosaic: -1 }
    }
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

/// Where one develop's wall time went, in seconds: opening the file
/// (identification and metadata), unpacking the sensor data, and the
/// develop that makes RGB of it (demosaic, color and the copy out).
#[doc(hidden)]
#[derive(Debug, Default, Clone, Copy)]
pub struct StageTimes {
    pub open: f64,
    pub unpack: f64,
    pub develop: f64,
}
