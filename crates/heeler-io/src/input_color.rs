//! Matrix/TRC input color management. The engine's working space is selected
//! here; RAW development and export tagging are deliberately outside this seam.
use heeler_engine::ImageBuf;
use std::{
    cell::RefCell,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub const CONVERSION_REVISION: u32 = 1;
const MAX_PROFILE: usize = 4 * 1024 * 1024;
pub(crate) type Matrix = [[f64; 3]; 3];
#[derive(Clone, Copy)]
pub struct WorkingSpace {
    pub name: &'static str,
    pub xyz_d65_to_rgb: Matrix,
}
pub const WORKING_SPACE: WorkingSpace = WorkingSpace {
    name: "linear-srgb",
    xyz_d65_to_rgb: [
        [3.2404542, -1.5371385, -0.4985314],
        [-0.9692660, 1.8760108, 0.0415560],
        [0.0556434, -0.2040259, 1.0572252],
    ],
};
const D50_TO_D65: Matrix = [
    [0.9555766, -0.0230393, 0.0631636],
    [-0.0282895, 1.0099416, 0.0210077],
    [0.0122982, -0.0204830, 1.3299098],
];
pub(crate) fn mul(m: Matrix, v: [f64; 3]) -> [f64; 3] {
    m.map(|r| r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
}
pub(crate) fn matrix(a: Matrix, b: Matrix) -> Matrix {
    std::array::from_fn(|r| std::array::from_fn(|c| (0..3).map(|k| a[r][k] * b[k][c]).sum()))
}
pub(crate) fn invert(m: Matrix) -> Option<Matrix> {
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
/// CIE xy chromaticities of an RGB encoding: three primaries and a white.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Primaries {
    pub red: [f64; 2],
    pub green: [f64; 2],
    pub blue: [f64; 2],
    pub white: [f64; 2],
}
pub const REC709: Primaries = Primaries { red: [0.64, 0.33], green: [0.30, 0.60], blue: [0.15, 0.06], white: [0.3127, 0.3290] };
/// ACES2065-1, the archival container (AP0).
pub const ACES_AP0: Primaries = Primaries { red: [0.7347, 0.2653], green: [0.0, 1.0], blue: [0.0001, -0.0770], white: [0.32168, 0.33767] };
/// ACEScg, the rendering working space (AP1).
pub const ACES_AP1: Primaries = Primaries { red: [0.713, 0.293], green: [0.165, 0.830], blue: [0.128, 0.044], white: [0.32168, 0.33767] };
pub const REC2020: Primaries = Primaries { red: [0.708, 0.292], green: [0.170, 0.797], blue: [0.131, 0.046], white: [0.3127, 0.3290] };
impl Primaries {
    /// Within the tolerance a file writer's rounding leaves.
    pub fn close_to(&self, other: &Primaries) -> bool {
        let near = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() < 2e-3 && (a[1] - b[1]).abs() < 2e-3;
        near(self.red, other.red) && near(self.green, other.green) && near(self.blue, other.blue) && near(self.white, other.white)
    }
    /// The name a user would recognize, or None for anything else.
    pub fn known_name(&self) -> Option<&'static str> {
        [(&REC709, "Rec. 709"), (&ACES_AP1, "ACEScg"), (&ACES_AP0, "ACES2065-1"), (&REC2020, "Rec. 2020")]
            .into_iter().find(|(p, _)| self.close_to(p)).map(|(_, n)| n)
    }
    /// A white as XYZ with Y = 1.
    fn white_xyz(xy: [f64; 2]) -> [f64; 3] {
        // A white at y = 0 (a corrupt or hand-typed header) would make
        // a NaN matrix that passes the determinant check and paints a
        // NaN picture; D65 stands in for it.
        if !(xy[1] > 0.0) || !xy[0].is_finite() {
            return [0.9504559, 1.0, 1.0890578];
        }
        [xy[0] / xy[1], 1.0, (1.0 - xy[0] - xy[1]) / xy[1]]
    }
    /// The chromaticities OpenEXR uses to say "these pixels are CIE XYZ":
    /// primaries at the corners of the diagram. Blue sits at y = 0
    /// there, so the usual construction divides by zero; the encoding
    /// is absolute and wants no matrix and no adaptation.
    pub fn is_xyz(&self) -> bool {
        let near = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).abs() < 2e-3 && (a[1] - b[1]).abs() < 2e-3;
        near(self.red, [1.0, 0.0]) && near(self.green, [0.0, 1.0]) && near(self.blue, [0.0, 0.0])
    }
    /// RGB to XYZ under this encoding's own white, the textbook
    /// construction: columns are the primaries' chromaticities scaled so
    /// that RGB 1,1,1 lands on the white. Column scale is free, so the
    /// unnormalized (x, y, 1 - x - y) form serves and a primary on the
    /// y = 0 edge is no trouble.
    pub fn rgb_to_xyz(&self) -> Option<Matrix> {
        let col = |xy: [f64; 2]| [xy[0], xy[1], 1.0 - xy[0] - xy[1]];
        let (r, g, b) = (col(self.red), col(self.green), col(self.blue));
        let cols = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
        let s = mul(invert(cols)?, Self::white_xyz(self.white));
        Some(std::array::from_fn(|i| std::array::from_fn(|j| cols[i][j] * s[j])))
    }
    /// Linear RGB in this encoding to the working space, adapting the
    /// white to D65 by Bradford when it differs (ACES sits at a white
    /// near D60). Identity for anything within tolerance of the working
    /// primaries, so a Rec. 709 file is never touched; absolute XYZ goes
    /// straight through the working space's own XYZ matrix.
    pub fn to_working(&self, working: WorkingSpace) -> Option<Matrix> {
        if self.close_to(&REC709) {
            return Some([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]);
        }
        if self.is_xyz() {
            return Some(working.xyz_d65_to_rgb);
        }
        let adapt = if (self.white[0] - REC709.white[0]).abs() < 1e-3 && (self.white[1] - REC709.white[1]).abs() < 1e-3 {
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
        } else {
            bradford(Self::white_xyz(self.white), Self::white_xyz(REC709.white))?
        };
        Some(matrix(working.xyz_d65_to_rgb, matrix(adapt, self.rgb_to_xyz()?)))
    }
}
/// Bradford chromatic adaptation from one white to another, both as XYZ
/// with Y = 1.
fn bradford(from: [f64; 3], to: [f64; 3]) -> Option<Matrix> {
    const B: Matrix = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
    let (s, d) = (mul(B, from), mul(B, to));
    let scale = [[d[0] / s[0], 0.0, 0.0], [0.0, d[1] / s[1], 0.0], [0.0, 0.0, d[2] / s[2]]];
    Some(matrix(invert(B)?, matrix(scale, B)))
}
#[derive(Clone, Debug)]
enum Curve {
    Identity,
    Gamma(f64),
    Table(Vec<f64>),
    Param(u16, Vec<f64>),
}
impl Curve {
    fn value(&self, x: f64) -> f64 {
        match self {
            Self::Identity => x,
            Self::Gamma(g) => x.max(0.0).powf(*g),
            Self::Table(v) => {
                let t = x.clamp(0.0, 1.0) * (v.len() - 1) as f64;
                let i = (t as usize).min(v.len() - 2);
                v[i] + (v[i + 1] - v[i]) * (t - i as f64)
            }
            Self::Param(kind, p) => {
                let g = p[0];
                match kind {
                    0 => x.max(0.0).powf(g),
                    1 => {
                        if x >= -p[2] / p[1] {
                            (p[1] * x + p[2]).max(0.0).powf(g)
                        } else {
                            0.0
                        }
                    }
                    2 => {
                        if x >= -p[2] / p[1] {
                            (p[1] * x + p[2]).max(0.0).powf(g) + p[3]
                        } else {
                            p[3]
                        }
                    }
                    3 => {
                        if x >= p[4] {
                            (p[1] * x + p[2]).max(0.0).powf(g)
                        } else {
                            p[3] * x
                        }
                    }
                    _ => {
                        if x >= p[4] {
                            (p[1] * x + p[2]).max(0.0).powf(g) + p[5]
                        } else {
                            p[3] * x + p[6]
                        }
                    }
                }
            }
        }
    }
}
fn u32be(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        b.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn u64be(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(
        b.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}
fn u16be(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes(
        b.get(at..at.checked_add(2)?)?.try_into().ok()?,
    ))
}
fn fixed(b: &[u8], at: usize) -> Option<f64> {
    Some(u32be(b, at)? as i32 as f64 / 65536.0)
}
fn curve(b: &[u8]) -> Option<Curve> {
    let result = match b.get(..4)? {
        b"curv" => match u32be(b, 8)? as usize {
            0 => Curve::Identity,
            1 => Curve::Gamma(u16be(b, 12)? as f64 / 256.0),
            n if n <= 65536 && n.checked_mul(2)?.checked_add(12)? <= b.len() => {
                let v: Vec<_> = (0..n)
                    .map(|i| u16be(b, 12 + i * 2).map(|v| v as f64 / 65535.0))
                    .collect::<Option<_>>()?;
                if v.windows(2).any(|v| v[1] < v[0]) {
                    return None;
                }
                Curve::Table(v)
            }
            _ => return None,
        },
        b"para" => {
            let kind = u16be(b, 8)?;
            let count = *([1, 3, 4, 5, 7].get(kind as usize)?);
            let p: Vec<_> = (0..count)
                .map(|i| fixed(b, 12 + i * 4))
                .collect::<Option<_>>()?;
            if p[0] <= 0.0 || p[0] > 10.0 || (kind > 0 && p[1] <= 0.0) {
                return None;
            }
            Curve::Param(kind, p)
        }
        _ => return None,
    };
    if let Curve::Gamma(g) = result {
        if g <= 0.0 || g > 10.0 {
            return None;
        }
    }
    // Reject singular, inverted or non-finite transfer definitions before pixels.
    let mut last = -1e-8;
    for i in 0..=256 {
        let y = result.value(i as f64 / 256.0);
        if !y.is_finite() || y < last - 1e-5 || !(-0.01..=16.0).contains(&y) {
            return None;
        }
        last = y;
    }
    if last <= 0.0 {
        return None;
    }
    Some(result)
}
struct Profile {
    xyz: Matrix,
    trc: [Curve; 3],
}
fn parse(b: &[u8]) -> Result<Profile, &'static str> {
    if b.len() < 132
        || b.len() > MAX_PROFILE
        || u32be(b, 0) != Some(b.len() as u32)
        || b.get(36..40) != Some(b"acsp")
    {
        return Err("malformed ICC profile");
    }
    if b.get(16..20) != Some(b"RGB ") {
        return Err("non-RGB ICC profile");
    }
    if b.get(20..24) != Some(b"XYZ ") {
        return Err("unsupported ICC connection space");
    }
    if !matches!(b[8], 2 | 4) {
        return Err("unsupported ICC version");
    }
    let count = u32be(b, 128).ok_or("missing tag table")? as usize;
    let end = count
        .checked_mul(12)
        .and_then(|n| n.checked_add(132))
        .filter(|n| *n <= b.len())
        .ok_or("invalid ICC tag table")?;
    let mut tags = std::collections::BTreeMap::new();
    for at in (132..end).step_by(12) {
        let sig = &b[at..at + 4];
        let offset = u32be(b, at + 4).unwrap() as usize;
        let size = u32be(b, at + 8).unwrap() as usize;
        let tag = offset
            .checked_add(size)
            .filter(|n| offset >= end && *n <= b.len())
            .and_then(|n| b.get(offset..n))
            .ok_or("invalid ICC tag extent")?;
        if tags.insert(sig, tag).is_some() {
            return Err("duplicate ICC tag");
        }
        if matches!(
            sig,
            b"A2B0"
                | b"A2B1"
                | b"A2B2"
                | b"B2A0"
                | b"B2A1"
                | b"B2A2"
                | b"D2B0"
                | b"D2B1"
                | b"D2B2"
                | b"D2B3"
        ) {
            return Err("LUT-based ICC profile");
        }
    }
    let xyz = |sig: &[u8]| -> Option<[f64; 3]> {
        let t = tags.get(sig)?;
        if t.get(..4)? != b"XYZ " {
            return None;
        }
        Some([fixed(t, 8)?, fixed(t, 12)?, fixed(t, 16)?])
    };
    // ICC rXYZ/gXYZ/bXYZ are already adapted to the D50 PCS, including
    // profiles with a chad tag. Applying chad again would adapt twice.
    let columns = [
        xyz(b"rXYZ").ok_or("missing ICC primaries")?,
        xyz(b"gXYZ").ok_or("missing ICC primaries")?,
        xyz(b"bXYZ").ok_or("missing ICC primaries")?,
    ];
    let xyz: Matrix = std::array::from_fn(|r| columns.map(|c| c[r]));
    let det = xyz[0][0] * (xyz[1][1] * xyz[2][2] - xyz[1][2] * xyz[2][1])
        - xyz[0][1] * (xyz[1][0] * xyz[2][2] - xyz[1][2] * xyz[2][0])
        + xyz[0][2] * (xyz[1][0] * xyz[2][1] - xyz[1][1] * xyz[2][0]);
    if det.abs() < 1e-8 || xyz.iter().flatten().any(|v| v.abs() > 8.0) {
        return Err("invalid ICC primaries");
    }
    // Matrix-shaper PCS is D50; reject a forged alternate PCS illuminant.
    let white = [
        fixed(b, 68).unwrap(),
        fixed(b, 72).unwrap(),
        fixed(b, 76).unwrap(),
    ];
    if white
        .iter()
        .zip([0.9642, 1.0, 0.8249])
        .any(|(a, b)| (a - b).abs() > 0.01)
    {
        return Err("unsupported ICC PCS illuminant");
    }
    let trc =
        [b"rTRC", b"gTRC", b"bTRC"].map(|sig| tags.get(sig.as_slice()).and_then(|t| curve(t)));
    let [Some(r), Some(g), Some(bl)] = trc else {
        return Err("invalid ICC transfer curve");
    };
    Ok(Profile {
        xyz,
        trc: [r, g, bl],
    })
}
thread_local! {static NAME:RefCell<String>=RefCell::new("image bytes".into());}
pub(crate) fn named<T>(path: &Path, run: impl FnOnce() -> T) -> T {
    struct Reset(String);
    impl Drop for Reset {
        fn drop(&mut self) {
            NAME.with(|n| *n.borrow_mut() = std::mem::take(&mut self.0));
        }
    }
    let _reset = Reset(NAME.with(|n| n.replace(path.display().to_string())));
    run()
}
/// One conversion site, shared by portable and native decoders. Alpha is
/// straight coverage and never enters the transfer functions or matrix.
pub fn convert(
    image: &mut ImageBuf,
    embedded: Result<Option<&[u8]>, &str>,
    working: WorkingSpace,
    mut log: impl FnMut(&str),
) {
    let parsed = match embedded {
        Ok(Some(b)) => parse(b).map(Some),
        Ok(None) => Ok(None),
        Err(e) => Err(e),
    };
    let profile = match parsed {
        Ok(p) => p,
        Err(reason) => {
            NAME.with(|n| {
                log(&format!(
                    "ICC fallback ({reason}); assuming sRGB: {}",
                    n.borrow()
                ))
            });
            None
        }
    };
    if let Some(p) = profile {
        let transform = matrix(working.xyz_d65_to_rgb, matrix(D50_TO_D65, p.xyz));
        for px in image.data.chunks_exact_mut(4) {
            let linear = std::array::from_fn(|c| p.trc[c].value(px[c] as f64));
            let rgb = mul(transform, linear);
            for c in 0..3 {
                px[c] = rgb[c] as f32;
            }
        }
    } else {
        // Keep the established untagged path bit exact. This is also the
        // explicit fallback for malformed, gray and LUT input profiles.
        for px in image.data.chunks_exact_mut(4) {
            for c in 0..3 {
                px[c] = crate::srgb_to_linear(px[c]);
            }
        }
        if working.name != "linear-srgb" {
            let srgb_to_xyz = [
                [0.4124564, 0.3575761, 0.1804375],
                [0.2126729, 0.7151522, 0.0721750],
                [0.0193339, 0.1191920, 0.9503041],
            ];
            let transform = matrix(working.xyz_d65_to_rgb, srgb_to_xyz);
            for px in image.data.chunks_exact_mut(4) {
                let rgb = mul(transform, [px[0] as f64, px[1] as f64, px[2] as f64]);
                for c in 0..3 {
                    px[c] = rgb[c] as f32;
                }
            }
        }
    }
}
pub(crate) fn legacy_raw() -> bool {
    NAME.with(|n| crate::is_raw_extension(Path::new(&*n.borrow())))
}
type DiagnosticLogger = Box<dyn Fn(&str) + Send + Sync>;
static LOGGER: std::sync::OnceLock<DiagnosticLogger> = std::sync::OnceLock::new();
pub fn set_diagnostic_logger(logger: impl Fn(&str) + Send + Sync + 'static) {
    let _ = LOGGER.set(Box::new(logger));
}
fn log_diagnostic(line: &str) {
    eprintln!("{line}");
    if let Some(log) = LOGGER.get() {
        log(line);
    }
}
pub(crate) fn ingest(image: &mut ImageBuf, embedded: Result<Option<&[u8]>, &str>) {
    convert(
        image,
        if legacy_raw() { Ok(None) } else { embedded },
        WORKING_SPACE,
        log_diagnostic,
    );
}
fn hash(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf29ce484222325, |h, b| {
        (h ^ *b as u64).wrapping_mul(0x100000001b3)
    })
}
pub fn identity(profile: Result<Option<&[u8]>, &str>) -> String {
    let id = match profile {
        Ok(Some(p)) => format!("icc{:016x}", hash(p)),
        Ok(None) => "untagged-srgb".into(),
        Err(e) => format!("invalid{:016x}", hash(e.as_bytes())),
    };
    format!("{}:icc-v{}:{id}", WORKING_SPACE.name, CONVERSION_REVISION)
}
/// Header-only fingerprint. JPEG is read by segments so cache lookups never
/// load its compressed image stream. PNG and TIFF decoders read only metadata.
///
/// Memoized by path, modification time and length: this is asked on every
/// source lookup, which sits under every preview render, and reopening the
/// file to walk its headers there is a cost the render must not pay twice.
/// Modification time and length are the identity every other cache in the
/// app already trusts for a file's content.
pub fn file_identity(path: &Path) -> String {
    if crate::is_raw_extension(path) {
        // Restoring Heeler DNG exposure on successful RAW decode changes
        // pixels, including old merge members and persisted thumbnails.
        // v4: corrected gain indexing and over-range tone interpolation (26.4.1).
        if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("dng")) {
            return format!("raw:icc-v{CONVERSION_REVISION}:dng-exposure-v4");
        }
        return format!("raw:icc-v{CONVERSION_REVISION}");
    }
    type Memo = std::collections::HashMap<std::path::PathBuf, (Option<std::time::SystemTime>, u64, String)>;
    static MEMO: std::sync::OnceLock<std::sync::Mutex<Memo>> = std::sync::OnceLock::new();
    let memo = MEMO.get_or_init(Default::default);
    let stamp = std::fs::metadata(path)
        .ok()
        .map(|m| (m.modified().ok(), m.len()));
    if let Some((modified, len)) = stamp {
        if let Some((m, l, id)) = memo.lock().unwrap_or_else(|e| e.into_inner()).get(path) {
            if *m == modified && *l == len {
                return id.clone();
            }
        }
    }
    let id = file_identity_uncached(path);
    if let Some((modified, len)) = stamp {
        let mut memo = memo.lock().unwrap_or_else(|e| e.into_inner());
        if memo.len() >= 4096 {
            memo.clear();
        }
        memo.insert(path.to_path_buf(), (modified, len, id.clone()));
    }
    id
}
fn file_identity_uncached(path: &Path) -> String {
    let read = || -> Result<Option<Vec<u8>>, String> {
        let mut file =
            std::io::BufReader::new(std::fs::File::open(path).map_err(|e| e.to_string())?);
        let mut magic = [0; 12];
        let n = file.read(&mut magic).map_err(|e| e.to_string())?;
        file.rewind().map_err(|e| e.to_string())?;
        if matches!(&magic[..2], b"II" | b"MM") {
            return tiff_profile(&mut file).map_err(str::to_owned);
        }
        if magic[..2] == [255, 216] {
            return jpeg_profile(&mut file).map_err(str::to_owned);
        }
        if n == 12 && crate::is_heif(&magic) {
            return heif_profile_reader(&mut file, true).map_err(str::to_owned);
        }
        let png_tagged = magic.starts_with(b"\x89PNG") && png_has_icc(&mut file).unwrap_or(false);
        file.rewind().map_err(|e| e.to_string())?;
        use image::ImageDecoder;
        let mut reader = image::ImageReader::new(file)
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let mut limits = image::Limits::default();
        limits.max_alloc = Some(MAX_PROFILE as u64);
        reader.limits(limits);
        let profile = reader
            .into_decoder()
            .and_then(|mut d| d.icc_profile())
            .map_err(|e| e.to_string())?;
        if profile.is_none() && png_tagged {
            return Err("cannot read embedded PNG ICC profile".into());
        }
        Ok(profile)
    };
    let result = read();
    identity(
        result
            .as_ref()
            .map(|p| p.as_deref())
            .map_err(|e| e.as_str()),
    )
}
pub(crate) fn png_has_icc(reader: &mut (impl Read + Seek)) -> Result<bool, &'static str> {
    let end = reader.seek(SeekFrom::End(0)).map_err(|_| "PNG length")?;
    reader
        .seek(SeekFrom::Start(8))
        .map_err(|_| "PNG signature")?;
    loop {
        let mut header = [0; 8];
        reader.read_exact(&mut header).map_err(|_| "PNG chunk")?;
        let n = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        if &header[4..] == b"iCCP" {
            return Ok(true);
        }
        if matches!(&header[4..], b"IDAT" | b"IEND") {
            return Ok(false);
        }
        let at = reader.stream_position().map_err(|_| "PNG seek")?;
        if at.checked_add(n + 4).is_none_or(|n| n > end) {
            return Err("PNG chunk extent");
        }
        reader
            .seek(SeekFrom::Start(at + n + 4))
            .map_err(|_| "PNG seek")?;
    }
}

pub(crate) fn tiff_profile(
    reader: &mut (impl Read + Seek),
) -> Result<Option<Vec<u8>>, &'static str> {
    let end = reader.seek(SeekFrom::End(0)).map_err(|_| "TIFF length")?;
    reader.rewind().map_err(|_| "TIFF seek")?;
    let mut header = [0; 8];
    reader.read_exact(&mut header).map_err(|_| "TIFF header")?;
    let little = match &header[..2] {
        b"II" => true,
        b"MM" => false,
        _ => return Err("TIFF byte order"),
    };
    let number = |b: &[u8]| -> u64 {
        if little {
            b.iter()
                .enumerate()
                .map(|(i, b)| (*b as u64) << (i * 8))
                .sum()
        } else {
            b.iter().fold(0, |n, b| (n << 8) | *b as u64)
        }
    };
    let big = match number(&header[2..4]) {
        42 => false,
        43 => true,
        _ => return Err("TIFF version"),
    };
    let offset = if big {
        if number(&header[4..6]) != 8 || number(&header[6..8]) != 0 {
            return Err("BigTIFF header");
        }
        let mut b = [0; 8];
        reader.read_exact(&mut b).map_err(|_| "BigTIFF offset")?;
        number(&b)
    } else {
        number(&header[4..8])
    };
    if offset == 0 {
        return Ok(None);
    }
    if offset >= end {
        return Err("TIFF directory offset");
    }
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|_| "TIFF seek")?;
    let mut count = [0; 8];
    let count_size = if big { 8 } else { 2 };
    reader
        .read_exact(&mut count[..count_size])
        .map_err(|_| "TIFF directory count")?;
    let count = number(&count[..count_size]);
    let entry_size = if big { 20 } else { 12 };
    if count > 65536
        || count
            .checked_mul(entry_size)
            .and_then(|n| n.checked_add(offset + count_size as u64))
            .is_none_or(|n| n > end)
    {
        return Err("TIFF directory extent");
    }
    let mut profile = None;
    for _ in 0..count {
        let mut e = [0; 20];
        reader
            .read_exact(&mut e[..entry_size as usize])
            .map_err(|_| "TIFF field")?;
        if number(&e[..2]) != 34675 {
            continue;
        }
        if profile.is_some() {
            return Err("duplicate TIFF ICC profile");
        }
        if !matches!(number(&e[2..4]), 1 | 7) {
            return Err("invalid TIFF ICC type");
        }
        let split = if big { 12 } else { 8 };
        let n = number(&e[4..split]);
        let inline = if big { 8 } else { 4 };
        if n > MAX_PROFILE as u64 {
            return Err("ICC profile too large");
        }
        let mut p = vec![0; n as usize];
        if n <= inline {
            p.copy_from_slice(&e[split..split + n as usize]);
        } else {
            let at = number(&e[split..split + inline as usize]);
            if at.checked_add(n).is_none_or(|n| n > end) {
                return Err("TIFF ICC extent");
            }
            let resume = reader.stream_position().map_err(|_| "TIFF seek")?;
            reader.seek(SeekFrom::Start(at)).map_err(|_| "TIFF seek")?;
            reader.read_exact(&mut p).map_err(|_| "TIFF ICC bytes")?;
            reader
                .seek(SeekFrom::Start(resume))
                .map_err(|_| "TIFF seek")?;
        }
        profile = Some(p);
    }
    Ok(profile)
}

pub(crate) fn jpeg_profile(
    reader: &mut (impl Read + Seek),
) -> Result<Option<Vec<u8>>, &'static str> {
    let mut soi = [0; 2];
    reader.read_exact(&mut soi).map_err(|_| "JPEG header")?;
    let mut chunks = std::collections::BTreeMap::new();
    let mut total = None;
    let mut bytes = 0;
    loop {
        let mut marker = [0; 2];
        reader.read_exact(&mut marker).map_err(|_| "JPEG marker")?;
        if marker[0] != 255 {
            return Err("JPEG marker");
        }
        while marker[1] == 255 {
            reader
                .read_exact(&mut marker[1..])
                .map_err(|_| "JPEG padding")?;
        }
        if matches!(marker[1], 0xda | 0xd9) {
            break;
        }
        if marker[1] == 1 || (0xd0..=0xd7).contains(&marker[1]) {
            continue;
        }
        let mut len = [0; 2];
        reader.read_exact(&mut len).map_err(|_| "JPEG length")?;
        let len = (u16::from_be_bytes(len) as usize)
            .checked_sub(2)
            .ok_or("JPEG length")?;
        if marker[1] != 0xe2 {
            reader
                .seek(SeekFrom::Current(len as i64))
                .map_err(|_| "JPEG segment")?;
            continue;
        }
        let mut segment = vec![0; len];
        reader.read_exact(&mut segment).map_err(|_| "JPEG APP2")?;
        if !segment.starts_with(b"ICC_PROFILE\0") {
            continue;
        }
        if len < 14 {
            return Err("malformed JPEG ICC chunks");
        }
        let (seq, count) = (segment[12], segment[13]);
        if seq == 0 || seq > count || total.is_some_and(|n| n != count) || chunks.contains_key(&seq)
        {
            return Err("malformed JPEG ICC chunks");
        }
        total = Some(count);
        bytes += len - 14;
        if bytes > MAX_PROFILE {
            return Err("ICC profile too large");
        }
        chunks.insert(seq, segment[14..].to_vec());
    }
    match total {
        None => Ok(None),
        Some(n) if chunks.len() == n as usize => Ok(Some(chunks.into_values().flatten().collect())),
        _ => Err("missing JPEG ICC chunks"),
    }
}
// HEIF property association parsing is shared with the platform decode path.
// Only properties of the primary item are used, never a thumbnail's profile.
pub(crate) fn heif_profile(bytes: &[u8]) -> Result<Option<Vec<u8>>, &'static str> {
    heif_profile_reader(&mut std::io::Cursor::new(bytes), false)
}
fn heif_profile_reader(
    reader: &mut (impl Read + Seek),
    identity_only: bool,
) -> Result<Option<Vec<u8>>, &'static str> {
    let end = reader.seek(SeekFrom::End(0)).map_err(|_| "HEIF length")?;
    reader.rewind().map_err(|_| "HEIF seek")?;
    while reader.stream_position().map_err(|_| "HEIF seek")? < end {
        let start = reader.stream_position().map_err(|_| "HEIF seek")?;
        let mut h = [0; 8];
        reader.read_exact(&mut h).map_err(|_| "HEIF box")?;
        let mut size = u32::from_be_bytes(h[..4].try_into().unwrap()) as u64;
        let mut header = 8;
        if size == 1 {
            let mut big = [0; 8];
            reader
                .read_exact(&mut big)
                .map_err(|_| "HEIF extended box")?;
            size = u64::from_be_bytes(big);
            header = 16;
        }
        if size == 0 {
            size = end - start;
        }
        if size < header || size > end - start {
            return Err("HEIF box extent");
        }
        if &h[4..] == b"meta" {
            let len = usize::try_from(size - header).map_err(|_| "HEIF metadata size")?;
            if len > MAX_PROFILE * 4 {
                return Err("HEIF metadata too large");
            }
            let mut data = vec![0; len];
            reader.read_exact(&mut data).map_err(|_| "HEIF metadata")?;
            return meta_profile(&data, identity_only);
        }
        reader
            .seek(SeekFrom::Start(start + size))
            .map_err(|_| "HEIF seek")?;
    }
    Ok(None)
}
fn boxes(mut b: &[u8]) -> Result<Vec<(&[u8], &[u8])>, &'static str> {
    let mut out = Vec::new();
    while !b.is_empty() {
        // ISO BMFF box sizes: 1 means a 64-bit size follows the type, 0
        // means the box runs to the end of its container. Neither has
        // been seen inside meta/ipco in a real file, but a walker that
        // reads 1 as a one-byte box fails a valid file loudly at probe.
        let (n, header) = match u32be(b, 0).ok_or("truncated HEIF box")? {
            1 => (
                usize::try_from(u64be(b, 8).ok_or("truncated HEIF box")?)
                    .map_err(|_| "invalid HEIF property extent")?,
                16,
            ),
            0 => (b.len(), 8),
            n => (n as usize, 8),
        };
        if n < header || n > b.len() {
            return Err("invalid HEIF property extent");
        }
        out.push((&b[4..8], &b[header..n]));
        b = &b[n..];
    }
    Ok(out)
}
fn meta_profile(meta: &[u8], identity_only: bool) -> Result<Option<Vec<u8>>, &'static str> {
    let parts = boxes(meta.get(4..).ok_or("HEIF meta header")?)?;
    let pitm = parts
        .iter()
        .find(|(k, _)| *k == b"pitm")
        .map(|(_, v)| *v)
        .ok_or("HEIF primary item missing")?;
    let primary = if pitm.first() == Some(&0) {
        u16be(pitm, 4).map(u32::from)
    } else {
        u32be(pitm, 4)
    }
    .ok_or("HEIF primary item")?;
    let Some((_, iprp)) = parts.iter().find(|(k, _)| *k == b"iprp") else {
        return Ok(None);
    };
    let props = boxes(iprp)?;
    let Some((_, ipco)) = props.iter().find(|(k, _)| *k == b"ipco") else {
        return Ok(None);
    };
    let properties = boxes(ipco)?;
    let mut selected = Vec::new();
    for (_, ipma) in props.iter().filter(|(k, _)| *k == b"ipma") {
        let flags = u32be(ipma, 0).ok_or("HEIF association header")?;
        let wide = flags & 1 != 0;
        let version = flags >> 24;
        let count = u32be(ipma, 4).ok_or("HEIF associations")?;
        let mut at = 8;
        for _ in 0..count {
            let id = if version == 0 {
                let id = u16be(ipma, at).map(u32::from);
                at += 2;
                id
            } else {
                let id = u32be(ipma, at);
                at += 4;
                id
            }
            .ok_or("HEIF item association")?;
            let n = *ipma.get(at).ok_or("HEIF association count")? as usize;
            at += 1;
            for _ in 0..n {
                let index = if wide {
                    let v = u16be(ipma, at).ok_or("HEIF association")?;
                    at += 2;
                    v & 0x7fff
                } else {
                    let v = *ipma.get(at).ok_or("HEIF association")?;
                    at += 1;
                    (v & 0x7f) as u16
                };
                if id == primary && index != 0 {
                    selected.push(index as usize - 1);
                }
            }
        }
    }
    let mut color_identity = Vec::new();
    for index in selected {
        let (kind, data) = properties.get(index).ok_or("HEIF property index")?;
        if *kind == b"colr" && identity_only {
            color_identity.extend_from_slice(&(data.len() as u32).to_be_bytes());
            color_identity.extend_from_slice(data);
            continue;
        }
        if *kind == b"colr" && matches!(data.get(..4), Some(b"prof" | b"rICC")) {
            let profile = data.get(4..).ok_or("HEIF ICC profile")?;
            if profile.len() > MAX_PROFILE {
                return Err("ICC profile too large");
            }
            return Ok(Some(profile.to_vec()));
        }
    }
    if color_identity.is_empty() {
        Ok(None)
    } else {
        Ok(Some(color_identity))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageDecoder, ImageEncoder};
    fn fixed_bytes(v: f64) -> [u8; 4] {
        ((v * 65536.0).round() as i32).to_be_bytes()
    }
    fn xyz(v: [f64; 3]) -> Vec<u8> {
        let mut b = b"XYZ \0\0\0\0".to_vec();
        for x in v {
            b.extend(fixed_bytes(x));
        }
        b
    }
    fn gamma(g: f64) -> Vec<u8> {
        let mut b = b"curv\0\0\0\0\0\0\0\x01".to_vec();
        b.extend(((g * 256.0).round() as u16).to_be_bytes());
        b
    }
    fn param(kind: u16, p: &[f64]) -> Vec<u8> {
        let mut b = b"para\0\0\0\0".to_vec();
        b.extend(kind.to_be_bytes());
        b.extend([0, 0]);
        for x in p {
            b.extend(fixed_bytes(*x));
        }
        b
    }
    fn profile(m: Matrix, trc: Vec<u8>) -> Vec<u8> {
        let tags = [
            (*b"rXYZ", xyz([m[0][0], m[1][0], m[2][0]])),
            (*b"gXYZ", xyz([m[0][1], m[1][1], m[2][1]])),
            (*b"bXYZ", xyz([m[0][2], m[1][2], m[2][2]])),
            (*b"rTRC", trc.clone()),
            (*b"gTRC", trc.clone()),
            (*b"bTRC", trc),
            (*b"wtpt", xyz([0.9642, 1.0, 0.8249])),
        ];
        let mut b = vec![0; 132 + tags.len() * 12];
        b[8] = 4;
        b[12..16].copy_from_slice(b"mntr");
        b[16..20].copy_from_slice(b"RGB ");
        b[20..24].copy_from_slice(b"XYZ ");
        b[36..40].copy_from_slice(b"acsp");
        for (i, x) in [0.9642, 1.0, 0.8249].iter().enumerate() {
            b[68 + i * 4..72 + i * 4].copy_from_slice(&fixed_bytes(*x));
        }
        b[128..132].copy_from_slice(&(tags.len() as u32).to_be_bytes());
        for (i, (sig, data)) in tags.into_iter().enumerate() {
            while b.len() % 4 != 0 {
                b.push(0);
            }
            let offset = b.len() as u32;
            let at = 132 + i * 12;
            b[at..at + 4].copy_from_slice(&sig);
            b[at + 4..at + 8].copy_from_slice(&offset.to_be_bytes());
            b[at + 8..at + 12].copy_from_slice(&(data.len() as u32).to_be_bytes());
            b.extend(data);
        }
        let size = b.len() as u32;
        b[..4].copy_from_slice(&size.to_be_bytes());
        b
    }
    fn inverse(m: Matrix) -> Matrix {
        let c = [
            [
                m[1][1] * m[2][2] - m[1][2] * m[2][1],
                m[1][2] * m[2][0] - m[1][0] * m[2][2],
                m[1][0] * m[2][1] - m[1][1] * m[2][0],
            ],
            [
                m[0][2] * m[2][1] - m[0][1] * m[2][2],
                m[0][0] * m[2][2] - m[0][2] * m[2][0],
                m[0][1] * m[2][0] - m[0][0] * m[2][1],
            ],
            [
                m[0][1] * m[1][2] - m[0][2] * m[1][1],
                m[0][2] * m[1][0] - m[0][0] * m[1][2],
                m[0][0] * m[1][1] - m[0][1] * m[1][0],
            ],
        ];
        let d = (0..3).map(|i| m[0][i] * c[0][i]).sum::<f64>();
        std::array::from_fn(|r| std::array::from_fn(|col| c[col][r] / d))
    }
    fn adaptation(from: [f64; 3], to: [f64; 3]) -> Matrix {
        let b = [
            [0.8951, 0.2664, -0.1614],
            [-0.7502, 1.7135, 0.0367],
            [0.0389, -0.0685, 1.0296],
        ];
        let f = mul(b, from);
        let t = mul(b, to);
        matrix(
            inverse(b),
            matrix(
                [
                    [t[0] / f[0], 0.0, 0.0],
                    [0.0, t[1] / f[1], 0.0],
                    [0.0, 0.0, t[2] / f[2]],
                ],
                b,
            ),
        )
    }
    fn patch(profile: &[u8], rgb: [f32; 3]) -> [f32; 4] {
        let mut b = ImageBuf::filled(1, 1, [rgb[0], rgb[1], rgb[2], 0.3]);
        convert(&mut b, Ok(Some(profile)), WORKING_SPACE, |s| panic!("{s}"));
        b.pixel(0, 0)
    }
    #[test]
    fn tagged_p3_adobe_and_prophoto_match_independent_xyz_reference() {
        // Matrices in each source's own white point. References use an
        // independently constructed Bradford adaptation, not the production
        // D50-to-D65 constant. ICC's fixed point tags justify a 0.0006 tolerance.
        let d50 = [0.9642, 1.0, 0.8249];
        let d65 = [0.95047, 1.0, 1.08883];
        let sources = [
            (
                [
                    [0.48657095, 0.26566769, 0.19821729],
                    [0.22897456, 0.69173852, 0.07928691],
                    [0.0, 0.04511338, 1.04394437],
                ],
                d65,
                [1.0, 0.0, 0.0],
                param(
                    4,
                    &[
                        2.4,
                        1.0 / 1.055,
                        0.055 / 1.055,
                        1.0 / 12.92,
                        0.04045,
                        0.0,
                        0.0,
                    ],
                ),
                2.4,
            ),
            (
                [
                    [0.5767309, 0.1855540, 0.1881852],
                    [0.2973769, 0.6273491, 0.0752741],
                    [0.0270343, 0.0706872, 0.9911085],
                ],
                d65,
                [0.0, 1.0, 0.0],
                gamma(563.0 / 256.0),
                563.0 / 256.0,
            ),
            (
                [
                    [0.7976749, 0.1351917, 0.0313534],
                    [0.2880402, 0.7118741, 0.0000857],
                    [0.0, 0.0, 0.8249],
                ],
                d50,
                [0.4, 0.6, 0.2],
                param(0, &[1.8]),
                1.8,
            ),
        ];
        let to_srgb = inverse([
            [0.4124564, 0.3575761, 0.1804375],
            [0.2126729, 0.7151522, 0.0721750],
            [0.0193339, 0.1191920, 0.9503041],
        ]);
        for (source, white, rgb, trc, g) in sources {
            let p = profile(matrix(adaptation(white, d50), source), trc);
            let actual = patch(&p, rgb);
            let reference = mul(
                matrix(to_srgb, matrix(adaptation(white, d65), source)),
                rgb.map(|v| (v as f64).powf(g)),
            );
            for c in 0..3 {
                assert!(
                    (actual[c] as f64 - reference[c]).abs() < 0.0006,
                    "{actual:?} vs {reference:?}"
                );
            }
            assert_eq!(actual[3], 0.3);
        }
    }
    #[test]
    fn fallbacks_are_exact_srgb_and_emit_named_diagnostics() {
        let mut grey = crate::srgb_profile().to_vec();
        grey[16..20].copy_from_slice(b"GRAY");
        let mut lut = crate::srgb_profile().to_vec();
        lut[132..136].copy_from_slice(b"A2B0");
        for (bytes, reason) in [
            (Some(b"broken".as_slice()), "malformed"),
            (Some(grey.as_slice()), "non-RGB"),
            (Some(lut.as_slice()), "LUT-based"),
            (None, ""),
        ] {
            let mut b = ImageBuf::filled(2, 1, [0.7, 0.3, 0.1, 0.25]);
            let mut messages = Vec::new();
            named(Path::new("/photos/patch.png"), || {
                convert(&mut b, Ok(bytes), WORKING_SPACE, |s| {
                    messages.push(s.to_string())
                })
            });
            assert_eq!(
                b.pixel(0, 0),
                [
                    crate::srgb_to_linear(0.7),
                    crate::srgb_to_linear(0.3),
                    crate::srgb_to_linear(0.1),
                    0.25
                ]
            );
            if reason.is_empty() {
                assert!(messages.is_empty());
            } else {
                assert_eq!(messages.len(), 1);
                assert!(messages[0].contains(reason));
                assert!(messages[0].ends_with("/photos/patch.png"));
            }
        }
    }
    #[test]
    fn all_curve_forms_and_forged_extents_are_bounded() {
        for (k, p) in [
            (0, vec![2.0]),
            (1, vec![2.0, 1.0, 0.0]),
            (2, vec![2.0, 1.0, 0.0, 0.0]),
            (3, vec![2.0, 1.0, 0.0, 1.0, 0.0]),
            (4, vec![2.0, 1.0, 0.0, 1.0, 0.0, 0.0, 0.0]),
        ] {
            assert!((curve(&param(k, &p)).unwrap().value(0.5) - 0.25).abs() < 1e-6);
        }
        let mut p = crate::srgb_profile().to_vec();
        assert!(parse(&p).is_ok());
        for size in [0, 12, 128, p.len() - 1] {
            assert!(parse(&p[..size]).is_err());
        }
        p[136..140].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(parse(&p).is_err());
        let bad = param(1, &[2.0, 0.0, 1.0]);
        assert!(curve(&bad).is_none());
    }
    #[test]
    fn portable_containers_extract_profiles_and_identity_changes() {
        let a = crate::srgb_profile().to_vec();
        let mut b = a.clone();
        // A valid, materially different red colorant at the same byte length.
        let count = u32be(&b, 128).unwrap();
        for i in 0..count as usize {
            let at = 132 + i * 12;
            if &b[at..at + 4] == b"rXYZ" {
                let offset = u32be(&b, at + 4).unwrap() as usize;
                b[offset + 8..offset + 12].copy_from_slice(&fixed_bytes(0.52));
            }
        }
        for format in [
            image::ImageFormat::Png,
            image::ImageFormat::Jpeg,
            image::ImageFormat::Tiff,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp
                .path()
                .join(format!("patch.{}", format.extensions_str()[0]));
            let encode = |p: Vec<u8>| {
                let mut bytes = std::io::Cursor::new(Vec::new());
                match format {
                    image::ImageFormat::Png => {
                        let mut e = image::codecs::png::PngEncoder::new(&mut bytes);
                        e.set_icc_profile(p).unwrap();
                        e.write_image(&[200, 80, 40, 77], 1, 1, image::ExtendedColorType::Rgba8)
                            .unwrap();
                    }
                    image::ImageFormat::Jpeg => {
                        let mut e =
                            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100);
                        e.set_icc_profile(p).unwrap();
                        e.write_image(&[200, 80, 40], 1, 1, image::ExtendedColorType::Rgb8)
                            .unwrap();
                    }
                    _ => {
                        let mut e = image::codecs::tiff::TiffEncoder::new(&mut bytes);
                        e.set_icc_profile(p).unwrap();
                        e.write_image(&[200, 80, 40, 77], 1, 1, image::ExtendedColorType::Rgba8)
                            .unwrap();
                    }
                };
                bytes.into_inner()
            };
            let encoded = encode(a.clone());
            std::fs::write(&path, &encoded).unwrap();
            let key = file_identity(&path);
            let old = crate::decode_bytes(&encoded).unwrap();
            let changed = encode(b.clone());
            std::fs::write(&path, &changed).unwrap();
            assert_ne!(key, file_identity(&path), "{format:?}");
            let new = crate::decode_bytes(&changed).unwrap();
            assert_ne!(old.data, new.data);
            let mut d = image::ImageReader::new(std::io::Cursor::new(&changed))
                .with_guessed_format()
                .unwrap()
                .into_decoder()
                .unwrap();
            let extracted = if format == image::ImageFormat::Tiff {
                tiff_profile(&mut std::io::Cursor::new(&changed)).unwrap()
            } else {
                d.icc_profile().unwrap()
            };
            assert_eq!(extracted.unwrap(), b);
            assert!(
                (new.data[3]
                    - if format == image::ImageFormat::Jpeg {
                        1.0
                    } else {
                        77.0 / 255.0
                    })
                .abs()
                    < 1e-6
            );
            let preview = crate::decode_preview(&path).unwrap();
            let full = crate::decode_any(&path).unwrap();
            assert_eq!(preview.data, full.data);
        }
    }
    fn bx(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut b = ((data.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend(kind);
        b.extend(data);
        b
    }
    #[test]
    fn heif_uses_primary_item_profile_not_thumbnail_and_rejects_bad_boxes() {
        let first = b"thumbnail profile";
        let second = crate::srgb_profile();
        let mut properties = bx(b"colr", &[b"prof".as_slice(), first].concat());
        properties.extend(bx(b"colr", &[b"prof".as_slice(), second].concat()));
        let ipma = [0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 1, 1, 0, 2, 1, 2];
        let iprp = [bx(b"ipco", &properties), bx(b"ipma", &ipma)].concat();
        let meta = [
            vec![0, 0, 0, 0],
            bx(b"pitm", &[0, 0, 0, 0, 0, 2]),
            bx(b"iprp", &iprp),
        ]
        .concat();
        let bytes = [bx(b"ftyp", b"heic\0\0\0\0"), bx(b"meta", &meta)].concat();
        assert_eq!(heif_profile(&bytes).unwrap().as_deref(), Some(second));
        let mut broken = bytes.clone();
        broken[0..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(heif_profile(&broken).is_err());
        for n in 1..bytes.len() {
            let _ = heif_profile(&bytes[..n]);
        }
    }
    /// The two other ISO BMFF size forms, inside the boxes the profile
    /// walk reads: a 64-bit size after the type, and a size of zero that
    /// runs to the end of the container.
    #[test]
    fn heif_walks_extended_and_to_end_boxes() {
        fn bx_large(kind: &[u8], data: &[u8]) -> Vec<u8> {
            let mut b = 1u32.to_be_bytes().to_vec();
            b.extend(kind);
            b.extend(((16 + data.len()) as u64).to_be_bytes());
            b.extend(data);
            b
        }
        fn bx_to_end(kind: &[u8], data: &[u8]) -> Vec<u8> {
            let mut b = 0u32.to_be_bytes().to_vec();
            b.extend(kind);
            b.extend(data);
            b
        }
        let first = b"thumbnail profile";
        let second = crate::srgb_profile();
        let mut properties = bx_large(b"colr", &[b"prof".as_slice(), first].concat());
        properties.extend(bx_to_end(b"colr", &[b"prof".as_slice(), second].concat()));
        let ipma = [0, 0, 0, 0, 0, 0, 0, 2, 0, 1, 1, 1, 0, 2, 1, 2];
        let iprp = [bx_large(b"ipco", &properties), bx(b"ipma", &ipma)].concat();
        let meta = [vec![0, 0, 0, 0], bx(b"pitm", &[0, 0, 0, 0, 0, 2]), bx_to_end(b"iprp", &iprp)].concat();
        let bytes = [bx(b"ftyp", b"heic\0\0\0\0"), bx(b"meta", &meta)].concat();
        assert_eq!(heif_profile(&bytes).unwrap().as_deref(), Some(second));
        // A 64-bit size that overstates its box is an error, not a read past the end.
        let mut lying = bytes.clone();
        let at = lying.windows(4).position(|w| w == b"ipco").unwrap() + 4;
        lying[at..at + 8].copy_from_slice(&u64::MAX.to_be_bytes());
        assert!(heif_profile(&lying).is_err());
        // So is one smaller than its own header: without the check the
        // content slice below runs from 16 down to 8 and panics.
        let mut small = bytes.clone();
        small[at..at + 8].copy_from_slice(&8u64.to_be_bytes());
        assert!(heif_profile(&small).is_err());
        for n in 1..bytes.len() {
            let _ = heif_profile(&bytes[..n]);
        }
    }
    #[test]
    fn raw_sources_keep_the_legacy_numeric_decode() {
        let mut bytes = crate::srgb_profile().to_vec();
        bytes[16..20].copy_from_slice(b"GRAY");
        let mut image = ImageBuf::filled(1, 1, [0.7, 0.2, 0.1, 1.0]);
        named(Path::new("camera.NEF"), || {
            ingest(&mut image, Ok(Some(&bytes)))
        });
        assert_eq!(
            image.pixel(0, 0),
            [
                crate::srgb_to_linear(0.7),
                crate::srgb_to_linear(0.2),
                crate::srgb_to_linear(0.1),
                1.0
            ]
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_heif_profile_and_preview_parity() {
        let temp = tempfile::tempdir().unwrap();
        let png = temp.path().join("tagged.png");
        let heif = temp.path().join("tagged.heic");
        let d65 = [0.95047, 1.0, 1.08883];
        let d50 = [0.9642, 1.0, 0.8249];
        let p3 = [
            [0.48657095, 0.26566769, 0.19821729],
            [0.22897456, 0.69173852, 0.07928691],
            [0.0, 0.04511338, 1.04394437],
        ];
        let icc = profile(
            matrix(adaptation(d65, d50), p3),
            param(
                4,
                &[
                    2.4,
                    1.0 / 1.055,
                    0.055 / 1.055,
                    1.0 / 12.92,
                    0.04045,
                    0.0,
                    0.0,
                ],
            ),
        );
        let mut bytes = Vec::new();
        let mut encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        encoder.set_icc_profile(icc).unwrap();
        encoder
            .write_image(
                &[220, 50, 30].repeat(32 * 32),
                32,
                32,
                image::ExtendedColorType::Rgb8,
            )
            .unwrap();
        std::fs::write(&png, &bytes).unwrap();
        let output = std::process::Command::new("sips")
            .args(["-s", "format", "heic"])
            .arg(&png)
            .arg("--out")
            .arg(&heif)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "native HEIF fixture encoder is required on this macOS test host"
        );
        let encoded = std::fs::read(&heif).unwrap();
        let full = crate::decode_any(&heif).unwrap();
        let preview = crate::decode_preview_at(&heif, crate::RawSourceOpts::default(), 16).unwrap();
        assert_eq!(full.data, preview.data);
        let small = crate::heic::decode_thumbnail(&encoded, 16).unwrap();
        let expected = crate::decode_bytes(&bytes).unwrap().pixel(16, 16);
        // Native HEVC is lossy and the OS bridge has 8-bit sample precision.
        for c in 0..3 {
            assert!(
                (full.pixel(16, 16)[c] - expected[c]).abs() < 0.035,
                "{:?} vs {expected:?}",
                full.pixel(16, 16)
            );
            assert!((small.pixel(8, 8)[c] - full.pixel(16, 16)[c]).abs() < 0.02);
        }
    }
}
