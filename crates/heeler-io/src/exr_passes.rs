//! OpenEXR intake: the beauty layer and, behind it, the render passes.
//!
//! An EXR is scene-linear by definition, so nothing here goes through
//! `input_color::ingest`, which would apply the sRGB curve a second
//! time. Primaries come from the `chromaticities` header when the writer
//! set one (ACES containers do; a 3D renderer, a layer editor and the
//! HDR mergers do not) and are otherwise assumed Rec. 709, the working space, which
//! is what every still-image writer produces.
//!
//! The reader works at the block level of the `exr` crate rather than
//! through its image API, so that only the channels asked for are ever
//! allocated: a render with thirty float passes at 4K is a gigabyte
//! through the image API and sixty megabytes here.
//!
//! What the file holds is described once by [`inspect`], and the rules for finding the
//! beauty in the naming conventions of three renderers (one renderer's
//! `ViewLayer.Combined.R`, another's bare `R`, a third's passes through a compositor
//! with no beauty at all) live in [`ExrInfo::beauty`]. Depth, normals and mattes are
//! cataloged here for the phases that read them; only [`decode_beauty`] is wired in.

use std::io::Cursor;

use exr::block::{chunk::Chunk, UncompressedBlock};
use exr::meta::attribute::SampleType;
use exr::meta::header::Header;
use exr::meta::MetaData;
use exr::prelude::f16;

use heeler_engine::memory::{self, Job};
use heeler_engine::ImageBuf;

use crate::input_color::{self, Primaries, WorkingSpace, WORKING_SPACE};
use crate::IoError;

/// The four bytes every OpenEXR file starts with.
pub const MAGIC: [u8; 4] = [0x76, 0x2f, 0x31, 0x01];

pub fn is_exr(bytes: &[u8]) -> bool {
    bytes.starts_with(&MAGIC)
}

/// Where the color image was found, or that it was not.
#[derive(Clone, Debug, PartialEq)]
pub enum Beauty {
    /// Three color channels and, when present, an alpha, by full name.
    Rgb { r: String, g: String, b: String, a: Option<String> },
    /// A luminance-only file: one channel for all three.
    Luminance { y: String, a: Option<String> },
    /// Passes only, no color image (one renderer's Cryptomatte samples). The
    /// beauty decodes as a neutral gray plate so the mattes stay usable.
    None,
}

/// A depth channel and what its numbers mean.
#[derive(Clone, Debug, PartialEq)]
pub struct DepthChannel {
    pub name: String,
    /// Metric distance from the camera (`Z`), as opposed to a `Mist`
    /// pass that is already a normalized 0..1 farness.
    pub metric: bool,
}

/// One object or material a Cryptomatte manifest names, with the hash
/// its coverage is keyed by.
#[derive(Clone, Debug, PartialEq)]
pub struct CryptoEntry {
    pub name: String,
    pub hash: u32,
}

/// A Cryptomatte layer: its manifest and the rank channels, in pairs
/// (id, coverage), rank 0 first.
#[derive(Clone, Debug, PartialEq)]
pub struct Cryptomatte {
    /// The layer's own name from the header (`ViewLayer.CryptoObject`,
    /// `uCryptoObject`), so a file with objects and materials lists both.
    pub layer: String,
    pub entries: Vec<CryptoEntry>,
    pub ranks: Vec<(String, String)>,
}

/// What an EXR holds, from its header alone.
#[derive(Clone, Debug)]
pub struct ExrInfo {
    /// Display window size: the picture, whatever region the pixels cover.
    pub width: usize,
    pub height: usize,
    /// Which part carries the beauty (0 for single-part files).
    pub part: usize,
    pub beauty: Beauty,
    /// The encoding the beauty is converted from.
    pub primaries: Primaries,
    pub depth: Option<DepthChannel>,
    /// X, Y, Z channel names of a normals pass.
    pub normals: Option<[String; 3]>,
    /// World to camera rotation when the writer recorded its camera
    /// (one renderer's `cameraTransform`, another's `worldToCamera`), as the matrix
    /// that takes a world-space direction to camera space by
    /// `n_cam = M * n_world`. Some renderers write none.
    pub world_to_camera: Option<[[f64; 3]; 3]>,
    pub cryptomattes: Vec<Cryptomatte>,
    /// Single float channels that are none of the above and read as a
    /// matte by name (`whitebarmask.mask`).
    pub mattes: Vec<String>,
    /// Every channel of the chosen part, for the info panel.
    pub channels: Vec<String>,
}

fn meta(bytes: &[u8]) -> Result<MetaData, IoError> {
    MetaData::read_from_buffered(Cursor::new(bytes), false)
        .map_err(|e| IoError::Unsupported(format!("OpenEXR header: {e}")))
}

/// The header of a file on disk, read without loading the pixels: what
/// the depth source check asks of every photograph it is handed.
fn meta_file(path: &std::path::Path) -> Result<MetaData, IoError> {
    let mut file = std::io::BufReader::new(std::fs::File::open(path)?);
    let mut magic = [0u8; 4];
    std::io::Read::read_exact(&mut file, &mut magic)?;
    if magic != MAGIC {
        return Err(IoError::UnsupportedFormat);
    }
    std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0))?;
    MetaData::read_from_buffered(file, false)
        .map_err(|e| IoError::Unsupported(format!("OpenEXR header: {e}")))
}

/// Display-window dimensions from the header only.
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let meta = meta(bytes).ok()?;
    let h = meta.headers.first()?;
    let size = h.shared_attributes.display_window.size;
    Some((size.width() as u32, size.height() as u32))
}

/// Channel name split into layer prefix and leaf: `ViewLayer.Combined.R`
/// is (`ViewLayer.Combined`, `R`), a bare `R` is (``, `R`).
fn split(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) => (&name[..i], &name[i + 1..]),
        None => ("", name),
    }
}

fn find(names: &[String], layer: &str, leaf: &str) -> Option<String> {
    names.iter().find(|n| {
        let (l, f) = split(n);
        l == layer && f.eq_ignore_ascii_case(leaf)
    }).cloned()
}

/// The layers of a channel list, in first-seen order.
fn layers(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for n in names {
        let l = split(n).0.to_string();
        if !out.contains(&l) {
            out.push(l);
        }
    }
    out
}

/// Rank channels of a Cryptomatte are the layer name followed by two
/// digits: `CryptoObject00`.
fn crypto_rank(layer: &str, crypto_names: &[String]) -> bool {
    crypto_names.iter().any(|c| {
        layer.len() == c.len() + 2 && layer.starts_with(c.as_str()) && layer[c.len()..].bytes().all(|b| b.is_ascii_digit())
    })
}

fn beauty_of(names: &[String], crypto_names: &[String]) -> Beauty {
    let alpha = |layer: &str| find(names, layer, "A");
    let rgb = |layer: &str| -> Option<Beauty> {
        let (r, g, b) = (find(names, layer, "R")?, find(names, layer, "G")?, find(names, layer, "B")?);
        Some(Beauty::Rgb { r, g, b, a: alpha(layer) })
    };
    if let Some(b) = rgb("") {
        return b;
    }
    let all = layers(names);
    let named = |want: &str| all.iter().find(|l| split(l).1.eq_ignore_ascii_case(want)).and_then(|l| rgb(l));
    for want in ["Combined", "beauty", "rgba", "rgb"] {
        if let Some(b) = named(want) {
            return b;
        }
    }
    if let Some(b) = all.iter().filter(|l| !l.is_empty() && !crypto_rank(l, crypto_names)).find_map(|l| rgb(l)) {
        return b;
    }
    if let Some(y) = find(names, "", "Y") {
        return Beauty::Luminance { y, a: alpha("") };
    }
    Beauty::None
}

fn depth_of(names: &[String]) -> Option<DepthChannel> {
    // A bare Z, a layer called depth, or a part whose name says depth
    // (the Beachball's depth_left and depth_right): metric distance.
    let leaf_says_depth = |l: &str| {
        let leaf = split(l).1.to_ascii_lowercase();
        leaf == "depth" || leaf.starts_with("depth_") || leaf.ends_with("_depth") || leaf.starts_with("depth.")
    };
    let metric = names.iter().find(|n| {
        let (l, f) = split(n);
        f == "Z" && (l.is_empty() || l.eq_ignore_ascii_case("depth") || leaf_says_depth(l))
    });
    if let Some(n) = metric {
        return Some(DepthChannel { name: n.clone(), metric: true });
    }
    names.iter().find(|n| split(n).1 == "Z" && split(split(n).0).1.eq_ignore_ascii_case("mist"))
        .map(|n| DepthChannel { name: n.clone(), metric: false })
}

fn normals_of(names: &[String]) -> Option<[String; 3]> {
    for layer in layers(names) {
        let leaf = split(&layer).1;
        // Normal, N, VRayNormals (three renderers' names): the word
        // anywhere in the leaf, or the bare letter.
        if !(leaf.to_ascii_lowercase().contains("normal") || leaf == "N") {
            continue;
        }
        for [x, y, z] in [["X", "Y", "Z"], ["R", "G", "B"]] {
            if let (Some(x), Some(y), Some(z)) = (find(names, &layer, x), find(names, &layer, y), find(names, &layer, z)) {
                return Some([x, y, z]);
            }
        }
    }
    None
}

/// A header text for a name of the user's choosing. OpenEXR texts are
/// Latin-1; an Export Layer called "レイヤー 1" is refused by name
/// rather than panicking inside the export.
fn text(s: &str) -> Result<exr::meta::attribute::Text, IoError> {
    exr::meta::attribute::Text::new_or_none(s)
        .ok_or_else(|| IoError::Unsupported(format!("'{s}' cannot be an OpenEXR name: only Latin-1 characters are allowed")))
}

fn text_attr(h: &Header, key: &str) -> Option<String> {
    use exr::meta::attribute::AttributeValue;
    let want = exr::meta::attribute::Text::new_or_none(key)?;
    h.own_attributes.other.get(&want).or_else(|| h.shared_attributes.other.get(&want)).and_then(|v| match v {
        AttributeValue::Text(t) => Some(t.to_string()),
        _ => None,
    })
}

/// Cryptomatte layers by the `cryptomatte/<id>/name` attributes. The
/// manifest is JSON of name to eight hex digits; a `manif_file` sidecar
/// is not read in this cut, and such a layer lists no entries.
fn cryptomattes_of(h: &Header, names: &[String], part: Option<&str>) -> Vec<Cryptomatte> {
    let mut ids: Vec<String> = h.own_attributes.other.keys().chain(h.shared_attributes.other.keys())
        .filter_map(|k: &exr::meta::attribute::Text| {
            let k = k.to_string();
            let rest = k.strip_prefix("cryptomatte/")?;
            let (id, tail) = rest.split_once('/')?;
            (tail == "name").then(|| id.to_string())
        })
        .collect();
    ids.sort();
    ids.dedup();
    ids.into_iter().filter_map(|id| {
        let layer = text_attr(h, &format!("cryptomatte/{id}/name"))?;
        let entries = text_attr(h, &format!("cryptomatte/{id}/manifest")).map(|m| manifest_entries(&m)).unwrap_or_default();
        let mut ranks = Vec::new();
        for k in 0.. {
            // In a multi-part file the rank channels sit under the part's
            // name; a layer already carrying it is left as it is.
            let rank = match part {
                Some(p) if !layer.starts_with(&format!("{p}.")) => format!("{p}.{layer}{k:02}"),
                _ => format!("{layer}{k:02}"),
            };
            let pair = |a: &str, b: &str| -> Option<(String, String)> {
                let id = find(names, &rank, a).or_else(|| find(names, &rank, long(a)))?;
                let cov = find(names, &rank, b).or_else(|| find(names, &rank, long(b)))?;
                Some((id, cov))
            };
            match (pair("r", "g"), pair("b", "a")) {
                (Some(p0), Some(p1)) => { ranks.push(p0); ranks.push(p1); }
                (Some(p0), None) => { ranks.push(p0); break; }
                _ => break,
            }
        }
        // The layer is named as its channels are: under the part in a
        // multi-part file, so two parts' crypto layers cannot collide.
        let layer = match part {
            Some(p) if !layer.starts_with(&format!("{p}.")) => format!("{p}.{layer}"),
            _ => layer,
        };
        (!ranks.is_empty()).then_some(Cryptomatte { layer, entries, ranks })
    }).collect()
}

fn long(leaf: &str) -> &'static str {
    match leaf {
        "r" => "red",
        "g" => "green",
        "b" => "blue",
        _ => "alpha",
    }
}

/// The manifest is a flat JSON object. Names may hold any character, so
/// this reads it as JSON strings rather than splitting on punctuation.
fn manifest_entries(json: &str) -> Vec<CryptoEntry> {
    let mut out = Vec::new();
    let mut chars = json.chars().peekable();
    let mut strings: Vec<String> = Vec::new();
    while let Some(c) = chars.next() {
        if c != '"' {
            continue;
        }
        let mut s = String::new();
        while let Some(c) = chars.next() {
            match c {
                '"' => break,
                '\\' => {
                    match chars.next() {
                        Some('u') => {
                            let hex: String = (0..4).filter_map(|_| chars.next()).collect();
                            if let Some(ch) = u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) { s.push(ch); }
                        }
                        Some('n') => s.push('\n'),
                        Some('t') => s.push('\t'),
                        Some(other) => s.push(other),
                        None => break,
                    }
                }
                other => s.push(other),
            }
        }
        strings.push(s);
    }
    for pair in strings.chunks_exact(2) {
        if let Ok(hash) = u32::from_str_radix(pair[1].trim(), 16) {
            out.push(CryptoEntry { name: pair[0].clone(), hash });
        }
    }
    out
}

/// The camera a renderer recorded, as world to camera for directions.
/// Both known writers use Imath's row-vector convention, translation in
/// the last row: one's `cameraTransform` is camera to world
/// (v_world = v_cam * M, so a direction goes back by the transpose of
/// the rotation block), the other's `worldToCamera` is world to camera as
/// it says (v_cam = v_world * M). Either becomes the column-vector
/// matrix the callers multiply with.
fn camera_of(h: &Header) -> Option<[[f64; 3]; 3]> {
    use exr::meta::attribute::AttributeValue;
    let get = |key: &str| {
        let k = exr::meta::attribute::Text::new_or_panic(key);
        h.own_attributes.other.get(&k).or_else(|| h.shared_attributes.other.get(&k)).and_then(|v| match v {
            AttributeValue::Matrix4x4(m) => Some(*m),
            _ => None,
        })
    };
    let rot = |m: [f32; 16]| -> [[f64; 3]; 3] { std::array::from_fn(|r| std::array::from_fn(|c| m[r * 4 + c] as f64)) };
    if let Some(m) = get("worldToCamera") {
        // v_cam[j] = sum_i v_world[i] * M[i][j]: column-vector form is M^T.
        let r = rot(m);
        return Some(std::array::from_fn(|j| std::array::from_fn(|i| r[i][j])));
    }
    if let Some(m) = get("cameraTransform") {
        // v_world[j] = sum_i v_cam[i] * R[i][j], so v_cam[i] = sum_j v_world[j] * R[i][j]:
        // column-vector form is R itself.
        return Some(rot(m));
    }
    None
}

/// A normals pass as Depth Lighting wants it: unit vectors in camera
/// space with x right, y DOWN in the image and z toward the viewer,
/// packed per pixel. `world_to_camera` rotates a world-space pass into
/// the camera's frame first; None takes the pass as camera space
/// already (x right, y up, z toward the viewer, the renderers'
/// convention), which is what a 3D renderer's compositor Vector Transform
/// writes. Zero-length normals (the background) stay zero.
pub fn camera_normals(x: &[f32], y: &[f32], z: &[f32], world_to_camera: Option<[[f64; 3]; 3]>) -> Vec<[f32; 3]> {
    (0..x.len().min(y.len()).min(z.len())).map(|i| {
        let mut n = [x[i] as f64, y[i] as f64, z[i] as f64];
        if let Some(m) = world_to_camera {
            n = input_color::mul(m, n);
        }
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if !(len > 1e-6) || !len.is_finite() {
            return [0.0, 0.0, 0.0];
        }
        [(n[0] / len) as f32, (-n[1] / len) as f32, (n[2] / len) as f32]
    }).collect()
}

fn primaries_of(h: &Header) -> Primaries {
    match &h.shared_attributes.chromaticities {
        Some(c) => Primaries {
            red: [c.red.x() as f64, c.red.y() as f64],
            green: [c.green.x() as f64, c.green.y() as f64],
            blue: [c.blue.x() as f64, c.blue.y() as f64],
            white: [c.white.x() as f64, c.white.y() as f64],
        },
        None => input_color::REC709,
    }
}

/// Reads the header and says what the file holds. Multi-part files are
/// searched in order for the first part with a beauty, which the
/// OpenEXR samples document as the default view's part; a file with no
/// beauty anywhere reports part 0 and `Beauty::None`.
pub fn inspect(bytes: &[u8]) -> Result<ExrInfo, IoError> {
    inspect_meta(&meta(bytes)?)
}

/// [`inspect`] for a file on disk, reading its header only. A
/// Cryptomatte whose manifest lives in a `manif_file` sidecar beside
/// the render gets its names from there.
pub fn inspect_file(path: &std::path::Path) -> Result<ExrInfo, IoError> {
    let meta = meta_file(path)?;
    let mut info = inspect_meta(&meta)?;
    let dir = path.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for crypto in info.cryptomattes.iter_mut().filter(|c| c.entries.is_empty()) {
        for h in &meta.headers {
            let ids: Vec<String> = h.own_attributes.other.keys().chain(h.shared_attributes.other.keys())
                .filter_map(|k| k.to_string().strip_prefix("cryptomatte/").and_then(|r| r.split_once('/')).map(|(id, _)| id.to_string()))
                .collect();
            for id in ids {
                let names_layer = text_attr(h, &format!("cryptomatte/{id}/name"));
                let same = names_layer.as_deref().is_some_and(|l| l == crypto.layer || crypto.layer.ends_with(&format!(".{l}")));
                if !same { continue; }
                if let Some(file) = text_attr(h, &format!("cryptomatte/{id}/manif_file")) {
                    if let Ok(json) = std::fs::read_to_string(dir.join(file)) {
                        crypto.entries = manifest_entries(&json);
                    }
                }
            }
        }
    }
    Ok(info)
}

/// One text attribute off the first header that carries it (26.3 Phase
/// 8): the Finish layer record (`heeler.layer.<name>.mode` and
/// friends) rides in the header for whoever opens the file, and this
/// reads it back without the exr crate's types leaking into callers.
pub fn header_text_file(path: &std::path::Path, key: &str) -> Option<String> {
    let m = meta_file(path).ok()?;
    m.headers.iter().find_map(|h| text_attr(h, key))
}

fn inspect_meta(meta: &MetaData) -> Result<ExrInfo, IoError> {
    if meta.headers.is_empty() {
        return Err(IoError::Unsupported("OpenEXR file with no parts".into()));
    }
    let parts = flat_parts(meta);
    if parts.is_empty() {
        return Err(IoError::Unsupported("OpenEXR file holds only deep data".into()));
    }
    // Luminance/chroma files sample their color channels at every
    // second pixel; the reader lifts lines as written, so a subsampled
    // channel would be read out of step. Refused by name.
    for &i in &parts {
        if let Some(c) = meta.headers[i].channels.list.iter().find(|c| c.sampling != exr::math::Vec2(1, 1)) {
            return Err(IoError::Unsupported(format!("OpenEXR subsampled channel {} (luminance/chroma) is not supported", c.name)));
        }
    }
    // The data window must sit inside the display window. A file that
    // breaks it is refused in words here, where the cause is known,
    // rather than deep in the block read as "invalid: decompressed data".
    for &i in &parts {
        let h = &meta.headers[i];
        let (data, disp) = (h.data_window(), h.shared_attributes.display_window);
        let end = |b: exr::meta::attribute::IntegerBounds| (b.position.x() as i64 + b.size.width() as i64, b.position.y() as i64 + b.size.height() as i64);
        let (de, pe) = (end(data), end(disp));
        let inside = data.position.x() >= disp.position.x()
            && data.position.y() >= disp.position.y()
            && de.0 <= pe.0
            && de.1 <= pe.1;
        if !inside {
            return Err(IoError::Unsupported(format!(
                "OpenEXR data window {data:?} exceeds the display window {disp:?}"
            )));
        }
    }
    // One description over every flat part: a multi-part file (several
    // renderers and compositors write them) keeps its passes in parts of their
    // own, and a reader that looks only at the beauty's part never
    // sees them. Channels are named by part, the OpenEXR convention.
    let ids = channel_ids(meta);
    let names: Vec<String> = ids.iter().map(|(id, _, _)| id.clone()).collect();
    let mut cryptomattes = Vec::new();
    for &i in &parts {
        let label = if parts.len() > 1 { Some(part_label(meta, i)) } else { None };
        cryptomattes.extend(cryptomattes_of(&meta.headers[i], &names, label.as_deref()));
    }
    let crypto_names: Vec<String> = cryptomattes.iter().map(|c| c.layer.clone()).collect();
    let beauty = beauty_of(&names, &crypto_names);
    let depth = depth_of(&names);
    let normals = normals_of(&names);
    let taken = |n: &String| -> bool {
        // The beauty's own alpha is not taken: it stays on the
        // matte list, since a photograph exported with a selection
        // as its alpha (Heeler's own EXR, or any RGBA render) wants
        // that channel back as a mask, not only as transparency.
        let used_by_beauty = match &beauty {
            Beauty::Rgb { r, g, b, .. } => n == r || n == g || n == b,
            Beauty::Luminance { y, .. } => n == y,
            Beauty::None => false,
        };
        used_by_beauty
            || depth.as_ref().is_some_and(|d| &d.name == n)
            || normals.as_ref().is_some_and(|ns| ns.contains(n))
            || cryptomattes.iter().any(|c| c.ranks.iter().any(|(i, cv)| i == n || cv == n) || split(n).0 == c.layer)
    };
    let vector_like = |n: &String| {
        let l = split(n).0.to_ascii_lowercase();
        l.contains("disparity") || l.contains("forward") || l.contains("backward") || l.contains("motion") || l.contains("vector")
    };
    // A color layer's R, G and B are a picture, not three mattes: a
    // renderer's light pass or an exported image layer would otherwise
    // flood the channel list. Its alpha stays, as a matte of the layer.
    let colour_layers: std::collections::HashSet<String> = layers(&names)
        .into_iter()
        .filter(|l| find(&names, l, "R").is_some() && find(&names, l, "G").is_some() && find(&names, l, "B").is_some())
        .collect();
    let colour_leaf = |n: &String| {
        let (l, f) = split(n);
        colour_layers.contains(l) && matches!(f.to_ascii_uppercase().as_str(), "R" | "G" | "B")
    };
    let mattes = names.iter().filter(|n| !taken(n) && !vector_like(n) && !colour_leaf(n) && split(n).1.len() > 0).cloned().collect();
    // The beauty's part carries the size, the primaries and the camera.
    let part = match &beauty {
        Beauty::Rgb { r, .. } => ids.iter().find(|(id, _, _)| id == r).map(|(_, p, _)| *p),
        Beauty::Luminance { y, .. } => ids.iter().find(|(id, _, _)| id == y).map(|(_, p, _)| *p),
        Beauty::None => None,
    }
    .unwrap_or(parts[0]);
    let h = &meta.headers[part];
    let size = h.shared_attributes.display_window.size;
    Ok(ExrInfo {
        width: size.width(),
        height: size.height(),
        part,
        beauty,
        primaries: primaries_of(h),
        depth,
        normals,
        world_to_camera: camera_of(h),
        cryptomattes,
        mattes,
        channels: names,
    })
}

/// The parts that hold flat (not deep) pixels, in file order.
fn flat_parts(meta: &MetaData) -> Vec<usize> {
    (0..meta.headers.len()).filter(|&i| !meta.headers[i].deep).collect()
}

/// A part's name from its header, or `partN` when the writer gave none.
fn part_label(meta: &MetaData, i: usize) -> String {
    meta.headers[i].own_attributes.layer_name.as_ref().map(|t| t.to_string()).unwrap_or_else(|| format!("part{i}"))
}

/// Every channel of every flat part under one id each: the channel's
/// own name in a single-part file; in a multi-part file the part's
/// name is the layer prefix (what a compositor shows), unless the channel
/// already carries it. Returns (id, part, channel name in the part).
fn channel_ids(meta: &MetaData) -> Vec<(String, usize, String)> {
    let parts = flat_parts(meta);
    let single = parts.len() <= 1;
    let mut out = Vec::new();
    for &i in &parts {
        let label = part_label(meta, i);
        for c in &meta.headers[i].channels.list {
            let name = c.name.to_string();
            let id = if single || name.starts_with(&format!("{label}.")) { name.clone() } else { format!("{label}.{name}") };
            out.push((id, i, name));
        }
    }
    out
}

/// Reads named channels of one part as f32 planes at display-window
/// size, the data window placed at its offset and the rest zero. Every
/// sample type converts to f32 (half, float, and the uint32 a
/// Cryptomatte writer already declared as float bits).
pub fn read_planes(bytes: &[u8], part: usize, names: &[&str]) -> Result<Vec<Vec<f32>>, IoError> {
    let meta = meta(bytes)?;
    read_planes_from(Cursor::new(bytes), &meta, bytes.len(), part, names, 1)
}

/// The planes box-averaged by an integer `factor` while the blocks are
/// read, so a thumbnail or a preview of a 24-megapixel render never
/// holds the full planes: only the reduced ones and one block. Each
/// reduced pixel is the mean of the source pixels that land in it; a
/// pixel the data window does not cover stays 0.0, as in the full read.
pub fn read_planes_reduced(bytes: &[u8], part: usize, names: &[&str], factor: usize) -> Result<Vec<Vec<f32>>, IoError> {
    let meta = meta(bytes)?;
    read_planes_from(Cursor::new(bytes), &meta, bytes.len(), part, names, factor.max(1))
}

/// [`read_planes`] for a file on disk, streamed rather than read whole.
pub fn read_planes_file(path: &std::path::Path, part: usize, names: &[&str]) -> Result<Vec<Vec<f32>>, IoError> {
    let meta = meta_file(path)?;
    let file = std::fs::File::open(path)?;
    let len = usize::try_from(file.metadata()?.len()).unwrap_or(usize::MAX);
    read_planes_from(std::io::BufReader::new(file), &meta, len.min(64 << 20), part, names, 1)
}

/// The dimensions a read at `factor` produces: the ceiling of each
/// side divided by the factor, so no source pixel is dropped.
pub fn reduced_size(width: usize, height: usize, factor: usize) -> (usize, usize) {
    let f = factor.max(1);
    (width.div_ceil(f).max(1), height.div_ceil(f).max(1))
}

/// The smallest integer factor that brings the longer side to at most
/// `max_edge` pixels; 1 when the picture already fits.
pub fn factor_for(width: usize, height: usize, max_edge: usize) -> usize {
    let long = width.max(height);
    if max_edge == 0 || long <= max_edge {
        return 1;
    }
    long.div_ceil(max_edge)
}

/// The bytes one decompressed block of `header` can take, which the
/// reader holds beside the planes.
fn block_bytes(header: &Header) -> usize {
    header.channels.bytes_per_pixel * header.max_block_pixel_size().area()
}

fn read_planes_from(
    read: impl std::io::Read + std::io::Seek,
    meta: &MetaData,
    encoded: usize,
    part: usize,
    names: &[&str],
    factor: usize,
) -> Result<Vec<Vec<f32>>, IoError> {
    let header = meta.headers.get(part).ok_or_else(|| IoError::Unsupported("OpenEXR part missing".into()))?;
    let display = header.shared_attributes.display_window;
    let (full_w, full_h) = (display.size.width(), display.size.height());
    let factor = factor.max(1);
    let (w, h) = reduced_size(full_w, full_h, factor);
    // A name is looked for in `part` first, then as a part-qualified id
    // anywhere in the file (a multi-part file's depth or matte part).
    let ids = channel_ids(meta);
    let mut wanted_by_part: std::collections::HashMap<usize, Vec<Option<usize>>> = std::collections::HashMap::new();
    for (slot, want) in names.iter().enumerate() {
        let found = header.channels.list.iter().position(|c| c.name.to_string() == *want).map(|ci| (part, ci))
            .or_else(|| {
                let (_, p, channel) = ids.iter().find(|(id, _, _)| id == want)?;
                let ci = meta.headers[*p].channels.list.iter().position(|c| c.name.to_string() == *channel)?;
                Some((*p, ci))
            });
        let Some((p, ci)) = found else {
            return Err(IoError::Unsupported(format!("OpenEXR channel {want} missing")));
        };
        let entry = wanted_by_part.entry(p).or_insert_with(|| vec![None; meta.headers[p].channels.list.len()]);
        entry[ci] = Some(slot);
    }
    let block = wanted_by_part.keys().map(|&p| block_bytes(&meta.headers[p])).max().unwrap_or(0);
    // The count plane exists only for a reduced read: it says how many
    // source pixels landed in each reduced one, for the mean at the end.
    let counts_bytes = if factor > 1 { memory::bytes(w, h, 1, 4)? } else { 0 };
    let needed = memory::sum([memory::bytes(w, h, names.len(), 4)?, counts_bytes, memory::bytes(block, 2, 1, 1)?, encoded])?;
    let _job = Job::admit(needed, "OpenEXR channel decode")?;
    let mut planes: Vec<Vec<f32>> = Vec::with_capacity(names.len());
    for _ in names {
        planes.push(memory::vector(w * h, 0.0f32, "OpenEXR plane")?);
    }
    let mut counts: Vec<u32> = if factor > 1 { memory::vector(w * h, 0u32, "OpenEXR reduction counts")? } else { Vec::new() };
    // Counted once per source pixel, on the first wanted channel, since
    // every channel's lines cover the same pixels.
    let count_slot = wanted_by_part.values().flat_map(|v| v.iter().flatten().copied()).min();
    let reader = exr::block::read(read, false).map_err(|e| IoError::Unsupported(format!("OpenEXR: {e}")))?;
    let chunks = reader.all_chunks(false).map_err(|e| IoError::Unsupported(format!("OpenEXR: {e}")))?;
    for chunk in chunks {
        let chunk: Chunk = chunk.map_err(|e| IoError::Unsupported(format!("OpenEXR chunk: {e}")))?;
        let Some(wanted) = wanted_by_part.get(&chunk.layer_index) else { continue };
        let header = &meta.headers[chunk.layer_index];
        let data = header.data_window();
        let (ox, oy) = (data.position.x() as i64 - display.position.x() as i64, data.position.y() as i64 - display.position.y() as i64);
        let types: Vec<SampleType> = header.channels.list.iter().map(|c| c.sample_type).collect();
        let block = UncompressedBlock::decompress_chunk(chunk, meta, false)
            .map_err(|e| IoError::Unsupported(format!("OpenEXR block: {e}")))?;
        if block.index.level != exr::math::Vec2(0, 0) {
            continue;
        }
        // A block shorter than its header promises would be sliced past
        // its end by the crate; a truncated or lying file is refused.
        let expect = header.channels.bytes_per_pixel * block.index.pixel_size.area();
        if block.data.len() < expect {
            return Err(IoError::Unsupported(format!("OpenEXR block holds {} bytes of {expect}", block.data.len())));
        }
        for line in block.lines(&header.channels) {
            let Some(slot) = wanted[line.location.channel] else { continue };
            let y = line.location.position.y() as i64 + oy;
            if y < 0 || y >= full_h as i64 {
                continue;
            }
            let x0 = line.location.position.x() as i64 + ox;
            let ry = y as usize / factor;
            let row = &mut planes[slot][ry * w..(ry + 1) * w];
            let counting = factor > 1 && Some(slot) == count_slot;
            let count_row: &mut [u32] = if counting { &mut counts[ry * w..(ry + 1) * w] } else { &mut [] };
            let mut put = |i: usize, v: f32| {
                let x = x0 + i as i64;
                if x >= 0 && x < full_w as i64 {
                    let rx = x as usize / factor;
                    if factor == 1 {
                        row[rx] = v;
                    } else {
                        row[rx] += v;
                        if counting {
                            count_row[rx] += 1;
                        }
                    }
                }
            };
            let bad = |e: exr::error::Error| IoError::Unsupported(format!("OpenEXR sample: {e}"));
            match types[line.location.channel] {
                SampleType::F16 => for (i, v) in line.read_samples::<f16>().enumerate() { put(i, v.map_err(bad)?.to_f32()); },
                SampleType::F32 => for (i, v) in line.read_samples::<f32>().enumerate() { put(i, v.map_err(bad)?); },
                SampleType::U32 => for (i, v) in line.read_samples::<u32>().enumerate() { put(i, v.map_err(bad)? as f32); },
            }
        }
    }
    if factor > 1 {
        for plane in &mut planes {
            for (v, &n) in plane.iter_mut().zip(counts.iter()) {
                if n > 0 {
                    *v /= n as f32;
                }
            }
        }
    }
    Ok(planes)
}

/// A depth pass as Heeler's depth convention: farness, 0 nearest and 1
/// farthest, normalized over the photograph. A metric `Z` is distance,
/// so nearness is its inverse over the finite range, which keeps the
/// perceptual spacing the model's disparity has (a step of one meter
/// matters up close and not at the horizon); the background, which
/// renderers mark as huge (1e10 in one, 1e30 in another), infinite, or
/// zero, pins to 1. A mist pass is already 0..1 farness and is only
/// clamped.
pub fn farness(plane: &[f32], metric: bool) -> Vec<f32> {
    if !metric {
        return plane.iter().map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 }).collect();
    }
    let finite = |z: f32| z.is_finite() && z > 0.0 && z < 1e9;
    let (lo, hi) = plane.iter().copied().filter(|z| finite(*z)).fold((f32::INFINITY, 0f32), |(lo, hi), z| (lo.min(z), hi.max(z)));
    if !(lo < hi) {
        return vec![1.0; plane.len()];
    }
    let (near, far) = (1.0 / lo, 1.0 / hi);
    let range = near - far;
    plane.iter().map(|&z| {
        if !finite(z) {
            return 1.0;
        }
        (1.0 - (1.0 / z - far) / range).clamp(0.0, 1.0)
    }).collect()
}

/// A matte to resolve from the file: objects (or materials) of one
/// Cryptomatte layer by name, or one plain channel.
#[derive(Clone, Debug, PartialEq)]
pub enum MatteRequest {
    /// Names from the manifest of the Cryptomatte layer called `layer`;
    /// their coverages add, so several objects make one matte.
    Crypto { layer: String, names: Vec<String> },
    /// A single channel, clamped to 0..1.
    Channel(String),
}

/// Reads a matte as a 0..1 plane at display-window size. Cryptomatte
/// coverage is the spec's: per rank pair (id, coverage), the coverage
/// where the id's float bits equal the object's hash, summed over
/// ranks, so anti-aliased and motion-blurred edges keep their partial
/// coverage. Names the manifest does not know contribute nothing.
pub fn read_matte_file(path: &std::path::Path, info: &ExrInfo, request: &MatteRequest) -> Result<Vec<f32>, IoError> {
    match request {
        MatteRequest::Channel(name) => {
            let planes = read_planes_file(path, info.part, &[name.as_str()])?;
            Ok(planes.into_iter().next().unwrap_or_default().iter().map(|v| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 }).collect())
        }
        MatteRequest::Crypto { layer, names } => {
            let crypto = info.cryptomattes.iter().find(|c| &c.layer == layer)
                .ok_or_else(|| IoError::Unsupported(format!("no Cryptomatte layer {layer} in the file")))?;
            let hashes: Vec<u32> = names.iter().filter_map(|n| crypto.entries.iter().find(|e| &e.name == n).map(|e| e.hash)).collect();
            let channels: Vec<&str> = crypto.ranks.iter().flat_map(|(id, cov)| [id.as_str(), cov.as_str()]).collect();
            let planes = read_planes_file(path, info.part, &channels)?;
            // The planes' own length, not the size an earlier header read
            // gave: a file rewritten at a new size between the two reads
            // must not index past the end.
            let count = planes.first().map_or(0, |p| p.len());
            let mut out = vec![0.0f32; count];
            if hashes.is_empty() {
                return Ok(out);
            }
            for pair in planes.chunks_exact(2) {
                let (ids, covs) = (&pair[0], &pair[1]);
                for i in 0..count {
                    let bits = ids[i].to_bits();
                    if hashes.iter().any(|h| *h == bits) {
                        out[i] += covs[i];
                    }
                }
            }
            for v in &mut out {
                *v = v.clamp(0.0, 1.0);
            }
            Ok(out)
        }
    }
}

/// The name of the object that covers a pixel most, by the Cryptomatte
/// layer's rank 0, or None over the background or an unnamed id: what a
/// click on the photograph picks.
pub fn crypto_name_at(path: &std::path::Path, info: &ExrInfo, layer: &str, x: usize, y: usize) -> Result<Option<String>, IoError> {
    let crypto = info.cryptomattes.iter().find(|c| c.layer == layer)
        .ok_or_else(|| IoError::Unsupported(format!("no Cryptomatte layer {layer} in the file")))?;
    let Some((id, cov)) = crypto.ranks.first() else { return Ok(None) };
    if x >= info.width || y >= info.height {
        return Ok(None);
    }
    let planes = read_planes_file(path, info.part, &[id.as_str(), cov.as_str()])?;
    let i = y * info.width + x;
    if i >= planes[0].len() || i >= planes[1].len() {
        return Ok(None);
    }
    if planes[1][i] <= 0.0 {
        return Ok(None);
    }
    let bits = planes[0][i].to_bits();
    Ok(crypto.entries.iter().find(|e| e.hash == bits).map(|e| e.name.clone()))
}

/// The color image as the engine wants it: RGBA f32, scene-linear in
/// the working space, display-window size, alpha 1 where the file has
/// none. Values above 1.0 are kept; a render's highlights are the
/// headroom the tone profile's shoulder exists for.
pub fn decode_beauty(bytes: &[u8]) -> Result<ImageBuf, IoError> {
    let info = inspect(bytes)?;
    decode_beauty_with(bytes, &info, WORKING_SPACE)
}

/// The beauty at most `max_edge` pixels on its longer side, box-averaged
/// while the blocks are read. What thumbnails and previews use: a
/// 24-megapixel render's full planes never exist for a 480-pixel
/// thumbnail. 2026-09-19: EXR thumbnails drew blank and the preview fell
/// back to the system decoder, which premultiplies the alpha and
/// linearizes linear data, so a photograph exported with a selection as
/// its alpha came back dark with contours.
pub fn decode_beauty_reduced(bytes: &[u8], max_edge: usize) -> Result<ImageBuf, IoError> {
    let info = inspect(bytes)?;
    decode_beauty_at(bytes, &info, WORKING_SPACE, factor_for(info.width, info.height, max_edge))
}

pub fn decode_beauty_with(bytes: &[u8], info: &ExrInfo, working: WorkingSpace) -> Result<ImageBuf, IoError> {
    decode_beauty_at(bytes, info, working, 1)
}

fn decode_beauty_at(bytes: &[u8], info: &ExrInfo, working: WorkingSpace, factor: usize) -> Result<ImageBuf, IoError> {
    let factor = factor.max(1);
    let (w, h) = reduced_size(info.width, info.height, factor);
    // Admitted for everything this decode holds at once: the RGBA
    // output, the planes it is built from, the reduction counts, one
    // block and the encoded file. The enclosing decode boundary
    // reserves nothing itself, so without this line the output buffer
    // was measured against whatever an earlier step happened to
    // reserve, and a full-size render was refused on a machine with
    // memory to spare (the "needs about 370 MiB, with 291 MiB
    // available" report of 2026-09-19).
    let planes_n = match &info.beauty {
        Beauty::Rgb { a, .. } => 3 + usize::from(a.is_some()),
        Beauty::Luminance { a, .. } => 1 + usize::from(a.is_some()),
        Beauty::None => 0,
    };
    let block = meta(bytes)?.headers.get(info.part).map(block_bytes).unwrap_or(0);
    let needed = memory::sum([
        memory::bytes(w, h, 4, 4)?,
        memory::bytes(w, h, planes_n.max(1), 4)?,
        if factor > 1 { memory::bytes(w, h, 1, 4)? } else { 0 },
        memory::bytes(block, 2, 1, 1)?,
        bytes.len(),
    ])?;
    let _job = Job::admit(needed, "OpenEXR beauty decode")?;
    let mut out = ImageBuf::try_new(w, h)?;
    let transform = info.primaries.to_working(working)
        .ok_or_else(|| IoError::Unsupported("OpenEXR chromaticities are degenerate".into()))?;
    let identity = transform == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let read = |names: &[&str]| -> Result<Vec<Vec<f32>>, IoError> {
        if factor > 1 { read_planes_reduced(bytes, info.part, names, factor) } else { read_planes(bytes, info.part, names) }
    };
    let names: Vec<String> = match &info.beauty {
        Beauty::Rgb { r, g, b, a } => [r, g, b].into_iter().chain(a.as_ref()).cloned().collect(),
        Beauty::Luminance { y, a } => std::iter::once(y).chain(a.as_ref()).cloned().collect(),
        Beauty::None => {
            // A passes-only file (Cryptomatte ranks and nothing else, the way a compositor
            // writes a matte pass out on its own) opens on the Cryptomatte's preview
            // picture when its un-numbered layer holds one: colors in 0..1, not the rank's
            // id floats. A gray plate otherwise (2026-09-20: "nothing loads in the canvas"
            // for bunny_CryptoObject.exr).
            match crypto_preview(bytes, info, &read)? {
                Some(planes) => {
                    fill_rgb(&mut out, &planes[..3], None, &transform, identity);
                    return Ok(out);
                }
                None => {
                    for px in out.data.chunks_exact_mut(4) {
                        px.copy_from_slice(&[0.18, 0.18, 0.18, 1.0]);
                    }
                    return Ok(out);
                }
            }
        }
    };
    let name_refs: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut planes = read(&name_refs)?;
    let mut alpha_at: Option<usize> = match &info.beauty {
        Beauty::Rgb { a, .. } => a.as_ref().map(|_| 3),
        _ => (planes.len() > 1).then_some(1),
    };
    let mut rgb_n = if matches!(&info.beauty, Beauty::Rgb { .. }) { 3 } else { 1 };
    // A beauty that is black in every channel is a file whose renderer
    // wrote the picture into its elements and left RGB blank (one
    // renderer's cornellBox sample: R, G, B all zero, the room in diffuse). The
    // first RGB layer with light in it stands in, in the file's order.
    if planes[..rgb_n].iter().all(|p| p.iter().all(|v| *v == 0.0)) {
        for layer in image_layers(info) {
            let (Some(r), Some(g), Some(b)) = (find(&info.channels, &layer, "R"), find(&info.channels, &layer, "G"), find(&info.channels, &layer, "B")) else { continue };
            let a = find(&info.channels, &layer, "A");
            let lit_names: Vec<&str> = [r.as_str(), g.as_str(), b.as_str()].into_iter().chain(a.as_deref()).collect();
            let lit = read(&lit_names)?;
            if lit[..3].iter().any(|p| p.iter().any(|v| *v != 0.0)) {
                alpha_at = a.as_ref().map(|_| 3);
                rgb_n = 3;
                planes = lit;
                break;
            }
        }
    }
    let alpha = alpha_at.and_then(|i| planes.get(i));
    let rgb: &[Vec<f32>] = &planes[..rgb_n];
    fill_rgb(&mut out, rgb, alpha, &transform, identity);
    Ok(out)
}

/// Writes one or three planes (and an alpha when given) into `out`,
/// through the primaries transform unless it is the identity.
fn fill_rgb(out: &mut ImageBuf, rgb: &[Vec<f32>], alpha: Option<&Vec<f32>>, transform: &[[f64; 3]; 3], identity: bool) {
    for (i, px) in out.data.chunks_exact_mut(4).enumerate() {
        let c = if rgb.len() == 3 { [rgb[0][i], rgb[1][i], rgb[2][i]] } else { [rgb[0][i]; 3] };
        let a = alpha.map_or(1.0, |a| a[i]);
        let c = unpremultiply(c, a);
        if identity {
            px[..3].copy_from_slice(&c);
        } else {
            let v = input_color::mul(*transform, [c[0] as f64, c[1] as f64, c[2] as f64]);
            px[0] = v[0] as f32;
            px[1] = v[1] as f32;
            px[2] = v[2] as f32;
        }
        px[3] = a;
    }
}

/// Below this an alpha is treated as zero for the division: a color
/// under it stays as stored, which for a premultiplied file is black,
/// or an additive element (fire, glow) that carries no coverage at all.
const ALPHA_FLOOR: f32 = 1e-6;

/// OpenEXR stores color premultiplied by alpha (associated); Heeler
/// holds it straight, as its every other format does. In on the way in,
/// out on the way out (final review, 2026-09-20: a 3D renderer's render of a
/// semi-transparent edge read darker than the renderer's own composite, and
/// Heeler's file at R 4.0 over A 0.5 merged in that renderer as 4.25 where
/// 2.25 was meant).
pub fn unpremultiply(c: [f32; 3], a: f32) -> [f32; 3] {
    if a.is_finite() && a > ALPHA_FLOOR && a != 1.0 { c.map(|v| v / a) } else { c }
}

pub fn premultiply(c: [f32; 3], a: f32) -> [f32; 3] {
    if a.is_finite() && a != 1.0 { c.map(|v| v * a.max(0.0)) } else { c }
}

/// The Cryptomatte preview of a passes-only file: the un-numbered
/// layer's R, G, B (or red, green, blue) when they read as colors,
/// every value finite and within 0..1 and at least one above zero. The
/// same channels hold rank id floats in some renderers' files (the
/// cornellBox sample), which is what the range test refuses.
fn crypto_preview(
    bytes: &[u8],
    info: &ExrInfo,
    read: &dyn Fn(&[&str]) -> Result<Vec<Vec<f32>>, IoError>,
) -> Result<Option<Vec<Vec<f32>>>, IoError> {
    let _ = bytes;
    for c in &info.cryptomattes {
        let leaf = |short: &str| find(&info.channels, &c.layer, short).or_else(|| find(&info.channels, &c.layer, long(short)));
        let (Some(r), Some(g), Some(b)) = (leaf("r"), leaf("g"), leaf("b")) else { continue };
        let planes = read(&[r.as_str(), g.as_str(), b.as_str()])?;
        let colours = planes.iter().all(|p| p.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
        let lit = planes.iter().any(|p| p.iter().any(|v| *v > 0.0));
        if colours && lit {
            return Ok(Some(planes));
        }
    }
    Ok(None)
}

/// The RGB(A) layer groups of a layered EXR, by layer name in header
/// order: every prefix holding R, G and B channels, minus the beauty
/// (the File node's default read), the depth and normals passes and
/// the Cryptomatte rank triples, which are passes rather than
/// pictures. "Layers from File..." lists these (26.3 Phase 7 import).
pub fn image_layers(info: &ExrInfo) -> Vec<String> {
    let mut skip: std::collections::HashSet<String> = std::collections::HashSet::new();
    macro_rules! take {
        ($name:expr) => {
            skip.insert(split($name).0.to_string())
        };
    }
    match &info.beauty {
        Beauty::Rgb { r, .. } => {
            take!(r);
        }
        Beauty::Luminance { y, .. } => {
            take!(y);
        }
        Beauty::None => {}
    }
    if let Some(d) = &info.depth {
        take!(&d.name);
    }
    if let Some(ns) = &info.normals {
        for n in ns {
            take!(n);
        }
    }
    for c in &info.cryptomattes {
        skip.insert(c.layer.clone());
        for (i, cv) in &c.ranks {
            take!(i);
            take!(cv);
        }
    }
    layers(&info.channels)
        .into_iter()
        .filter(|l| !l.is_empty() && !skip.contains(l))
        .filter(|l| {
            find(&info.channels, l, "R").is_some()
                && find(&info.channels, l, "G").is_some()
                && find(&info.channels, l, "B").is_some()
        })
        .collect()
}

/// One named layer of a layered EXR as a picture (26.3 Phase 7 import):
/// its R, G, B (and A when the layer carries one) converted into the
/// working space at display-window size, alpha 1 where the layer has
/// none. Errors when no layer of that name holds RGB, which is how a
/// resaved file that dropped the layer reads.
pub fn decode_layer_file(path: &std::path::Path, name: &str) -> Result<ImageBuf, IoError> {
    let info = inspect_file(path)?;
    let rgb = (
        find(&info.channels, name, "R"),
        find(&info.channels, name, "G"),
        find(&info.channels, name, "B"),
    );
    let (Some(r), Some(g), Some(b)) = rgb else {
        return Err(IoError::Unsupported(format!("the file has no RGB layer named '{name}'")));
    };
    let a = find(&info.channels, name, "A");
    let names: Vec<&str> = [r.as_str(), g.as_str(), b.as_str()].into_iter().chain(a.as_deref()).collect();
    let planes = read_planes_file(path, info.part, &names)?;
    let transform = info
        .primaries
        .to_working(WORKING_SPACE)
        .ok_or_else(|| IoError::Unsupported("OpenEXR chromaticities are degenerate".into()))?;
    let identity = transform == [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut out = ImageBuf::try_new(info.width, info.height)?;
    let alpha = planes.get(3);
    fill_rgb(&mut out, &planes[..3], alpha, &transform, identity);
    Ok(out)
}

// Writing (26.3 Phase 3c) -------------------------------------------------

/// One layer of a layered EXR export: a name and its channels as (leaf,
/// plane) pairs, written view-layer style as prefixed channels of a single
/// part. The beauty is the EMPTY-named layer with the leaves R, G, B, A,
/// landing as the bare channels every reader looks at first (a compositor calls
/// that layer "rgba"). A mask is one channel, `<name>.A` (or a bare
/// `<name>` when the leaf is empty); depth is the layer `depth` with the
/// leaf `Z`, the name a compositor already speaks. Planes are
/// width * height f32, row-major over the display window.
pub struct Layer {
    pub name: String,
    pub channels: Vec<(String, Vec<f32>)>,
}

/// Writes a layered EXR: the beauty plus the planes the channel node
/// produces (Phase 5), laid out the way a 3D renderer writes a render: ONE
/// part, every channel prefixed with its layer's name, which is the
/// layout this module's reader (and the compositors and renderers) read without a
/// part index. Scene-linear and unbounded, nothing clamped. The beauty
/// is the empty-named layer with leaves R, G, B, A, landing as the bare
/// channels every reader looks at first (a compositor calls that layer "rgba").
/// Depth stays f32 (the file's one measured-looking plane); color and
/// masks halve to f16, all the precision a matte or a graded beauty can
/// show, at half the bytes. The header says Rec. 709 (the working space)
/// and which Heeler wrote it.
pub fn write_layers(path: &std::path::Path, width: usize, height: usize, layers: &[Layer]) -> Result<(), IoError> {
    write_layers_with_attributes(path, width, height, layers, &[])
}

/// The same write with extra string attributes in the header (26.3
/// Phase 7): a Finish layer's blend mode, opacity and group ride as
/// `heeler.layer.<name>.mode` and friends. No reader acts on them;
/// they are a record, said so in the docs.
pub fn write_layers_with_attributes(
    path: &std::path::Path,
    width: usize,
    height: usize,
    layers: &[Layer],
    extra: &[(String, String)],
) -> Result<(), IoError> {
    use exr::prelude::*;

    if width == 0 || height == 0 || layers.is_empty() {
        return Err(IoError::UnsupportedFormat);
    }
    let px = width * height;
    let channel_name = |layer: &crate::exr_passes::Layer, leaf: &str| -> String {
        if layer.name.is_empty() {
            leaf.to_string()
        } else if leaf.is_empty() {
            layer.name.clone()
        } else {
            format!("{}.{}", layer.name, leaf)
        }
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for layer in layers {
        if layer.channels.is_empty() {
            return Err(IoError::Unsupported(format!("layer '{}' has no channels", layer.name)));
        }
        for (leaf, plane) in &layer.channels {
            if plane.len() != px {
                return Err(IoError::Unsupported(format!(
                    "channel '{}.{}' holds {} values for a {} by {} frame",
                    layer.name, leaf, plane.len(), width, height
                )));
            }
            if !seen.insert(channel_name(layer, leaf)) {
                return Err(IoError::Unsupported(format!("two channels named '{}'", channel_name(layer, leaf))));
            }
        }
    }
    let channel_total: usize = layers.iter().map(|l| l.channels.len()).sum();
    let _job = Job::admit(
        memory::sum([memory::bytes(width, height, channel_total, 48)?, 1024 * 1024])?,
        "EXR write",
    )?;

    let mut channels: Vec<AnyChannel<FlatSamples>> = Vec::with_capacity(channel_total);
    for layer in layers {
        // Depth goes out as f32: a metric Z, or Heeler's own farness under
        // the mist name (0 near, 1 far, what a renderer's mist pass is).
        let float = layer.name == "depth" || layer.name == "mist";
        // A layer with color and coverage goes out premultiplied, the
        // OpenEXR convention every compositor merges by (see premultiply).
        let leaf_of = |want: &str| layer.channels.iter().find(|(leaf, _)| leaf.eq_ignore_ascii_case(want)).map(|(_, p)| p);
        let coverage = match (leaf_of("R"), leaf_of("G"), leaf_of("B"), leaf_of("A")) {
            (Some(_), Some(_), Some(_), Some(a)) => Some(a),
            _ => None,
        };
        for (leaf, plane) in &layer.channels {
            let name = text(&channel_name(layer, leaf))?;
            let colour = coverage.is_some() && ["R", "G", "B"].iter().any(|c| leaf.eq_ignore_ascii_case(c));
            let samples: std::borrow::Cow<[f32]> = match (colour, coverage) {
                (true, Some(a)) => std::borrow::Cow::Owned(plane.iter().zip(a.iter()).map(|(v, a)| premultiply([*v; 3], *a)[0]).collect()),
                _ => std::borrow::Cow::Borrowed(plane.as_slice()),
            };
            channels.push(if float {
                AnyChannel::new(name, FlatSamples::F32(samples.into_owned()))
            } else {
                AnyChannel::new(name, FlatSamples::F16(samples.iter().map(|v| f16::from_f32(*v)).collect()))
            });
        }
    }
    // ZIP over sixteen scanlines, what renderers and compositors write: RLE on
    // half-float photographs compresses almost nothing.
    let part = exr::prelude::Layer::new(
        (width, height),
        LayerAttributes::default(),
        Encoding::SMALL_LOSSLESS,
        AnyChannels::sort(channels.into_iter().collect()),
    );
    let rec709 = input_color::REC709;
    let mut attributes = ImageAttributes::new(IntegerBounds::new(Vec2(0, 0), (width, height)));
    attributes.chromaticities = Some(exr::meta::attribute::Chromaticities {
        red: Vec2(rec709.red[0] as f32, rec709.red[1] as f32),
        green: Vec2(rec709.green[0] as f32, rec709.green[1] as f32),
        blue: Vec2(rec709.blue[0] as f32, rec709.blue[1] as f32),
        white: Vec2(rec709.white[0] as f32, rec709.white[1] as f32),
    });
    attributes.other.insert(
        text("heeler")?,
        AttributeValue::Text(text(&format!("Heeler {}", env!("CARGO_PKG_VERSION")))?),
    );
    for (key, value) in extra {
        attributes.other.insert(text(key)?, AttributeValue::Text(text(value)?));
    }
    let mut image = Image::from_layer(part);
    image.attributes = attributes;
    // to_file deletes its destination on any encoder error. Keep the
    // lazy open, so validation cannot truncate an existing file, but
    // leave any partial write in place under the never-delete rule.
    image.write().to_unbuffered(exr::io::LateFile::from(path))
        .map_err(|e| IoError::Unsupported(format!("could not write {}: {e}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use exr::prelude::*;
    use exr::prelude::Layer as ExrLayer;
    use exr::meta::attribute::Chromaticities;

    /// Writes a layered file the way a 3D renderer names things, with a data
    /// window inset from the display window, so the placement and the
    /// beauty rule are both exercised without a binary fixture.
    fn view_layer_style(path: &std::path::Path, chroma: Option<Chromaticities>) {
        let size = (8usize, 6usize);
        let ch = |name: &str, f: Box<dyn Fn(usize, usize) -> f32>| {
            AnyChannel::new(name, FlatSamples::F32((0..size.0 * size.1).map(|i| f(i % size.0, i / size.0)).collect()))
        };
        let channels = AnyChannels::sort(vec![
            ch("ViewLayer.Combined.R", Box::new(|x, _| x as f32 * 0.25)),
            ch("ViewLayer.Combined.G", Box::new(|_, y| y as f32 * 0.5)),
            ch("ViewLayer.Combined.B", Box::new(|_, _| 2.5)),
            ch("ViewLayer.Combined.A", Box::new(|_, _| 0.75)),
            ch("ViewLayer.CryptoObject00.r", Box::new(|_, _| f32::from_bits(0xcb432898))),
            ch("ViewLayer.CryptoObject00.g", Box::new(|x, _| if x < 4 { 1.0 } else { 0.0 })),
            ch("ViewLayer.CryptoObject00.b", Box::new(|_, _| 0.0)),
            ch("ViewLayer.CryptoObject00.a", Box::new(|_, _| 0.0)),
            ch("ViewLayer.Depth.Z", Box::new(|x, _| 5.0 + x as f32)),
            ch("ViewLayer.Normal.X", Box::new(|_, _| 0.0)),
            ch("ViewLayer.Normal.Y", Box::new(|_, _| 0.0)),
            ch("ViewLayer.Normal.Z", Box::new(|_, _| 1.0)),
            ch("ViewLayer.Mist.Z", Box::new(|_, _| 0.5)),
            ch("ViewLayer.Extra.mask", Box::new(|_, _| 0.25)),
        ].into_iter().collect());
        let mut layer = ExrLayer::new(size, LayerAttributes::default(), Encoding::FAST_LOSSLESS, channels);
        layer.attributes.layer_position = Vec2(2, 1);
        let mut attrs = ImageAttributes::new(IntegerBounds::new(Vec2(0, 0), (12, 9)));
        attrs.chromaticities = chroma;
        let mut image = Image::from_layer(layer);
        image.attributes = attrs;
        let manifest = r#"{"Ground":"24950135","Suzanne":"cb432898","has \"quote\"":"0000ffff"}"#;
        let put = |img: &mut Image<ExrLayer<AnyChannels<FlatSamples>>>, k: &str, v: &str| {
            img.layer_data.attributes.other.insert(Text::new_or_panic(k), AttributeValue::Text(Text::new_or_panic(v)));
        };
        put(&mut image, "cryptomatte/542cafa/name", "ViewLayer.CryptoObject");
        put(&mut image, "cryptomatte/542cafa/manifest", manifest);
        put(&mut image, "cryptomatte/542cafa/hash", "MurmurHash3_32");
        image.write().to_file(path).unwrap();
    }

    /// A render whose beauty is black in every channel opens on the first
    /// RGB layer with light in it, in the file's order (the cornellBox
    /// sample: R, G, B all zero, the room in diffuse; 2026-09-20: "nothing
    /// loads in the canvas"). A beauty with light in it is never
    /// second-guessed.
    #[test]
    fn a_blank_beauty_opens_on_the_first_lit_layer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blank.exr");
        let (w, h) = (4usize, 3usize);
        let px = w * h;
        let flat = |v: f32| vec![v; px];
        let rgb = |v: f32| -> Vec<(String, Vec<f32>)> { ["R", "G", "B"].iter().map(|n| (n.to_string(), flat(v))).collect() };
        write_layers(&path, w, h, &[
            crate::exr_passes::Layer { name: String::new(), channels: [("R".to_string(), flat(0.0)), ("G".to_string(), flat(0.0)), ("B".to_string(), flat(0.0)), ("A".to_string(), flat(1.0))].to_vec() },
            crate::exr_passes::Layer { name: "GI".into(), channels: rgb(0.0) },
            crate::exr_passes::Layer { name: "diffuse".into(), channels: rgb(0.5) },
            crate::exr_passes::Layer { name: "specular".into(), channels: rgb(0.9) },
        ]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let img = decode_beauty(&bytes).unwrap();
        assert!(img.data.chunks_exact(4).all(|p| (p[0] - 0.5).abs() < 0.002 && p[3] == 1.0), "diffuse, the first lit layer, not GI (blank) and not specular (later)");
        // A beauty with light in it stands: the layers are not consulted.
        let lit = dir.path().join("lit.exr");
        write_layers(&lit, w, h, &[
            crate::exr_passes::Layer { name: String::new(), channels: rgb(0.25) },
            crate::exr_passes::Layer { name: "diffuse".into(), channels: rgb(0.5) },
        ]).unwrap();
        let img = decode_beauty(&std::fs::read(&lit).unwrap()).unwrap();
        assert!(img.data.chunks_exact(4).all(|p| (p[0] - 0.25).abs() < 0.002));
    }

    /// A passes-only file, Cryptomatte ranks and nothing else, opens on
    /// the Cryptomatte's preview picture when its un-numbered layer
    /// holds colors (a renderer through a compositor, bunny_CryptoObject.exr), and on
    /// a gray plate when that layer holds rank floats instead.
    #[test]
    fn a_passes_only_file_opens_on_its_cryptomatte_preview() {
        let dir = tempfile::tempdir().unwrap();
        let size = (8usize, 6usize);
        let build = |path: &std::path::Path, preview_red: f32| {
            let ch = |name: &str, v: f32| AnyChannel::new(name, FlatSamples::F32(vec![v; size.0 * size.1]));
            let channels = AnyChannels::sort(vec![
                ch("uCryptoObject.red", preview_red),
                ch("uCryptoObject.green", 0.4),
                ch("uCryptoObject.blue", 0.8),
                ch("uCryptoObject00.red", f32::from_bits(0xcb432898)),
                ch("uCryptoObject00.green", 1.0),
                ch("uCryptoObject00.blue", 0.0),
                ch("uCryptoObject00.alpha", 0.0),
            ].into_iter().collect());
            let layer = ExrLayer::new(size, LayerAttributes::default(), Encoding::FAST_LOSSLESS, channels);
            let mut image = Image::from_layer(layer);
            image.attributes = ImageAttributes::new(IntegerBounds::new(Vec2(0, 0), size));
            let put = |img: &mut Image<ExrLayer<AnyChannels<FlatSamples>>>, k: &str, v: &str| {
                img.layer_data.attributes.other.insert(Text::new_or_panic(k), AttributeValue::Text(Text::new_or_panic(v)));
            };
            put(&mut image, "cryptomatte/542cafa/name", "uCryptoObject");
            put(&mut image, "cryptomatte/542cafa/manifest", r#"{"bunny":"cb432898"}"#);
            put(&mut image, "cryptomatte/542cafa/hash", "MurmurHash3_32");
            image.write().to_file(path).unwrap();
        };
        let preview = dir.path().join("preview.exr");
        build(&preview, 0.0);
        let bytes = std::fs::read(&preview).unwrap();
        let info = inspect(&bytes).unwrap();
        assert!(matches!(info.beauty, Beauty::None), "no beauty layer");
        let img = decode_beauty(&bytes).unwrap();
        let p = img.pixel(3, 2);
        assert!(p[0] == 0.0 && (p[1] - 0.4).abs() < 1e-5 && (p[2] - 0.8).abs() < 1e-5 && p[3] == 1.0, "the preview colors: {p:?}");
        // Rank floats in the un-numbered layer are not a picture: gray plate.
        let ids = dir.path().join("ids.exr");
        build(&ids, f32::from_bits(0xcb432898));
        let img = decode_beauty(&std::fs::read(&ids).unwrap()).unwrap();
        assert_eq!(img.pixel(3, 2), [0.18, 0.18, 0.18, 1.0]);
    }

    #[test]
    fn view_layer_layout_is_understood() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.exr");
        view_layer_style(&path, None);
        let bytes = std::fs::read(&path).unwrap();
        assert!(is_exr(&bytes));
        assert_eq!(dimensions(&bytes), Some((12, 9)));
        let info = inspect(&bytes).unwrap();
        assert_eq!((info.width, info.height, info.part), (12, 9, 0));
        assert_eq!(info.beauty, Beauty::Rgb {
            r: "ViewLayer.Combined.R".into(), g: "ViewLayer.Combined.G".into(), b: "ViewLayer.Combined.B".into(), a: Some("ViewLayer.Combined.A".into()),
        });
        assert_eq!(info.primaries.known_name(), Some("Rec. 709"));
        assert_eq!(info.depth, Some(DepthChannel { name: "ViewLayer.Depth.Z".into(), metric: true }));
        assert_eq!(info.normals.as_ref().map(|n| n[2].as_str()), Some("ViewLayer.Normal.Z"));
        assert_eq!(info.cryptomattes.len(), 1);
        let c = &info.cryptomattes[0];
        assert_eq!(c.layer, "ViewLayer.CryptoObject");
        assert_eq!(c.ranks, vec![
            ("ViewLayer.CryptoObject00.r".to_string(), "ViewLayer.CryptoObject00.g".to_string()),
            ("ViewLayer.CryptoObject00.b".to_string(), "ViewLayer.CryptoObject00.a".to_string()),
        ]);
        assert_eq!(c.entries[1], CryptoEntry { name: "Suzanne".into(), hash: 0xcb432898 });
        assert_eq!(c.entries[2].name, "has \"quote\"");
        // Mist is a second depth candidate but Z wins; it, the hand
        // matte and the beauty's own alpha are offered by name, the
        // color, crypto and normal channels not.
        assert_eq!(info.mattes, vec!["ViewLayer.Combined.A".to_string(), "ViewLayer.Extra.mask".to_string(), "ViewLayer.Mist.Z".to_string()]);
    }

    #[test]
    fn beauty_lands_in_the_display_window_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.exr");
        view_layer_style(&path, None);
        let bytes = std::fs::read(&path).unwrap();
        let img = decode_beauty(&bytes).unwrap();
        assert_eq!((img.width, img.height), (12, 9));
        // Outside the data window: black, alpha 0.
        assert_eq!(img.pixel(0, 0), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(img.pixel(11, 8), [0.0, 0.0, 0.0, 0.0]);
        // Data pixel (3, 2) sits at display (5, 3): no curve, no clamp.
        // The fixture's color is premultiplied, as a renderer's is, so
        // the straight color Heeler holds is the stored value over A.
        let straight = |c: [f32; 3]| c.map(|v| v / 0.75);
        let close = |got: [f32; 4], want: [f32; 4]| got.iter().zip(want.iter()).all(|(g, w)| (g - w).abs() < 1e-5);
        assert!(close(img.pixel(5, 3), [straight([0.75, 1.0, 2.5])[0], straight([0.75, 1.0, 2.5])[1], straight([0.75, 1.0, 2.5])[2], 0.75]), "{:?}", img.pixel(5, 3));
        assert!(close(img.pixel(2, 1), [0.0, 0.0, 2.5 / 0.75, 0.75]), "{:?}", img.pixel(2, 1));
        // Rows past the data window are untouched too.
        assert_eq!(img.pixel(9, 7), [0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn passes_read_as_planes_with_their_types() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.exr");
        view_layer_style(&path, None);
        let bytes = std::fs::read(&path).unwrap();
        let planes = read_planes(&bytes, 0, &["ViewLayer.Depth.Z", "ViewLayer.CryptoObject00.r", "ViewLayer.CryptoObject00.g"]).unwrap();
        assert_eq!(planes[0][3 * 12 + 5], 8.0);
        assert_eq!(planes[1][3 * 12 + 5].to_bits(), 0xcb432898);
        assert_eq!(planes[2][3 * 12 + 5], 1.0);
        assert_eq!(planes[2][3 * 12 + 8], 0.0);
        assert!(matches!(read_planes(&bytes, 0, &["nope"]), Err(IoError::Unsupported(_))));
    }

    #[test]
    fn acescg_chromaticities_convert_to_the_working_space() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("aces.exr");
        view_layer_style(&path, Some(Chromaticities {
            red: Vec2(0.713, 0.293), green: Vec2(0.165, 0.830), blue: Vec2(0.128, 0.044), white: Vec2(0.32168, 0.33767),
        }));
        let bytes = std::fs::read(&path).unwrap();
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.primaries.known_name(), Some("ACEScg"));
        let img = decode_beauty(&bytes).unwrap();
        // The published ACEScg to linear sRGB matrix (AP1 to XYZ, Bradford
        // D60 to D65, XYZ to sRGB) maps AP1 (0.75, 1.0, 2.5) to
        // (0.4488, 1.0168, 2.7361); this must agree to the third place.
        // The stored color is premultiplied by the fixture's 0.75 alpha
        // and comes back straight, so the conversion is judged on the
        // color times A.
        let px = img.pixel(5, 3);
        for (got, want) in px.iter().zip([0.4488f32, 1.0168, 2.7361]) {
            assert!((got * 0.75 - want).abs() < 2e-3, "{px:?}");
        }
        assert_eq!(px[3], 0.75);
        // A gray stays gray through any well-formed conversion.
        let m = info.primaries.to_working(WORKING_SPACE).unwrap();
        let g = input_color::mul(m, [0.5, 0.5, 0.5]);
        for c in g { assert!((c - 0.5).abs() < 0.01, "{g:?}"); }
    }

    #[test]
    fn xyz_encoded_pixels_go_straight_through_the_xyz_matrix() {
        let xyz = Primaries { red: [1.0, 0.0], green: [0.0, 1.0], blue: [0.0, 0.0], white: [1.0 / 3.0, 1.0 / 3.0] };
        assert!(xyz.is_xyz());
        let m = xyz.to_working(WORKING_SPACE).unwrap();
        // D65 white in XYZ is sRGB white, to the precision of the matrix.
        let w = input_color::mul(m, [0.9505, 1.0, 1.089]);
        for c in w { assert!((c - 1.0).abs() < 2e-3, "{w:?}"); }
        // And Rec. 2020 has a well-formed matrix with a green primary
        // far outside sRGB: pure 2020 green goes negative in red.
        let g = input_color::mul(input_color::REC2020.to_working(WORKING_SPACE).unwrap(), [0.0, 1.0, 0.0]);
        assert!(g[0] < -0.5 && g[1] > 1.0, "{g:?}");
    }

    #[test]
    fn bare_rgb_and_luminance_and_no_beauty() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain.exr");
        let chans = |names: &[&str]| AnyChannels::sort(names.iter().map(|n| AnyChannel::new(*n, FlatSamples::F16(vec![f16::from_f32(0.5); 4]))).collect());
        Image::from_layer(ExrLayer::new((2, 2), LayerAttributes::default(), Encoding::FAST_LOSSLESS, chans(&["R", "G", "B", "Z", "uCryptoWildcard00.R", "uCryptoWildcard00.G"]))).write().to_file(&plain).unwrap();
        let bytes = std::fs::read(&plain).unwrap();
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.beauty, Beauty::Rgb { r: "R".into(), g: "G".into(), b: "B".into(), a: None });
        assert_eq!(info.depth.as_ref().map(|d| d.name.as_str()), Some("Z"));
        assert_eq!(decode_beauty(&bytes).unwrap().pixel(1, 1), [0.5, 0.5, 0.5, 1.0]);

        let luma = dir.path().join("y.exr");
        Image::from_layer(ExrLayer::new((2, 2), LayerAttributes::default(), Encoding::FAST_LOSSLESS, chans(&["Y"]))).write().to_file(&luma).unwrap();
        let bytes = std::fs::read(&luma).unwrap();
        assert_eq!(inspect(&bytes).unwrap().beauty, Beauty::Luminance { y: "Y".into(), a: None });
        assert_eq!(decode_beauty(&bytes).unwrap().pixel(0, 0), [0.5, 0.5, 0.5, 1.0]);

        let none = dir.path().join("crypto.exr");
        Image::from_layer(ExrLayer::new((2, 2), LayerAttributes::default(), Encoding::FAST_LOSSLESS, chans(&["uCryptoObject00.red", "uCryptoObject00.green"]))).write().to_file(&none).unwrap();
        let bytes = std::fs::read(&none).unwrap();
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.beauty, Beauty::None);
        assert_eq!(decode_beauty(&bytes).unwrap().pixel(0, 0), [0.18, 0.18, 0.18, 1.0]);
    }

    #[test]
    fn normals_land_in_the_lighting_convention() {
        // Camera space as written: x right, y up, z out. Heeler flips y.
        let out = camera_normals(&[0.0, 0.6, 0.0], &[1.0, 0.0, 0.0], &[0.0, 0.8, 0.0], None);
        assert_eq!(out[0], [0.0, -1.0, 0.0]);
        assert!((out[1][0] - 0.6).abs() < 1e-6 && (out[1][2] - 0.8).abs() < 1e-6);
        assert_eq!(out[2], [0.0, 0.0, 0.0], "the background has no normal");
        // A world pass through a camera that looks along world +y with
        // world +z up (the cornellBox sample): world up becomes camera up.
        let m = [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]];
        let out = camera_normals(&[0.0], &[0.0], &[1.0], Some(m));
        assert_eq!(out[0], [0.0, -1.0, 0.0], "world up is screen up, which is y down negative");
        // Facing the camera: world -y becomes camera +z, toward the viewer.
        let out = camera_normals(&[0.0], &[-1.0], &[0.0], Some(m));
        assert_eq!(out[0], [0.0, 0.0, 1.0]);
    }

    #[test]
    fn a_camera_transform_in_the_header_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cam.exr");
        let chans = AnyChannels::sort(["R", "G", "B"].iter().map(|n| AnyChannel::new(*n, FlatSamples::F16(vec![f16::from_f32(0.5); 4]))).collect());
        let mut image = Image::from_layer(ExrLayer::new((2, 2), LayerAttributes::default(), Encoding::FAST_LOSSLESS, chans));
        // The cornellBox sample matrix: rows are the camera axes in world space.
        let cam_to_world = [1.0f32, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 5.0, 20.0, 1.0];
        image.layer_data.attributes.other.insert(Text::new_or_panic("cameraTransform"), AttributeValue::Matrix4x4(cam_to_world));
        image.write().to_file(&path).unwrap();
        let info = inspect_file(&path).unwrap();
        assert_eq!(info.world_to_camera, Some([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]]));
        assert_eq!(inspect(&std::fs::read(dir.path().join("cam.exr")).unwrap()).unwrap().world_to_camera, info.world_to_camera);
    }

    #[test]
    fn depth_becomes_farness() {
        // Metric: 2 m nearest, 10 m farthest, background at 1e10 and inf.
        let far = farness(&[2.0, 10.0, 1e10, f32::INFINITY, 4.0, 0.0], true);
        assert_eq!(far[0], 0.0);
        assert_eq!(far[1], 1.0);
        assert_eq!(far[2], 1.0);
        assert_eq!(far[3], 1.0);
        assert_eq!(far[5], 1.0);
        // 4 m sits at inverse-depth 0.25 between 0.5 (near) and 0.1 (far):
        // (0.25 - 0.1) / 0.4 = 0.375 nearness, so 0.625 farness.
        assert!((far[4] - 0.625).abs() < 1e-6, "{}", far[4]);
        // Mist is farness already.
        assert_eq!(farness(&[0.2, 1.5, -1.0, f32::NAN], false), vec![0.2, 1.0, 0.0, 1.0]);
        // A flat plane has no range and is all far.
        assert_eq!(farness(&[3.0, 3.0], true), vec![1.0, 1.0]);
    }

    #[test]
    fn file_readers_match_the_byte_readers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.exr");
        view_layer_style(&path, None);
        let bytes = std::fs::read(&path).unwrap();
        let by_file = inspect_file(&path).unwrap();
        let by_bytes = inspect(&bytes).unwrap();
        assert_eq!(by_file.beauty, by_bytes.beauty);
        assert_eq!(by_file.depth, by_bytes.depth);
        assert_eq!(by_file.channels, by_bytes.channels);
        let a = read_planes_file(&path, 0, &["ViewLayer.Depth.Z"]).unwrap();
        let b = read_planes(&bytes, 0, &["ViewLayer.Depth.Z"]).unwrap();
        assert_eq!(a, b);
        let png = dir.path().join("no.png");
        std::fs::write(&png, b"\x89PNG not an exr").unwrap();
        assert!(matches!(inspect_file(&png), Err(IoError::UnsupportedFormat)));
    }

    #[test]
    fn mattes_resolve_by_name_and_by_pixel() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.exr");
        view_layer_style(&path, None);
        let info = inspect_file(&path).unwrap();
        let layer = info.cryptomattes[0].layer.clone();
        let suzanne = read_matte_file(&path, &info, &MatteRequest::Crypto { layer: layer.clone(), names: vec!["Suzanne".into()] }).unwrap();
        assert_eq!(suzanne.len(), 12 * 9);
        // Coverage 1 for data x < 4 (display x 2..6) inside the data window, 0 elsewhere.
        assert_eq!(suzanne[3 * 12 + 2], 1.0);
        assert_eq!(suzanne[3 * 12 + 5], 1.0);
        assert_eq!(suzanne[3 * 12 + 6], 0.0);
        assert_eq!(suzanne[0], 0.0);
        // A name the manifest lacks adds nothing; two names add.
        let none = read_matte_file(&path, &info, &MatteRequest::Crypto { layer: layer.clone(), names: vec!["Nobody".into()] }).unwrap();
        assert!(none.iter().all(|v| *v == 0.0));
        let both = read_matte_file(&path, &info, &MatteRequest::Crypto { layer: layer.clone(), names: vec!["Ground".into(), "Suzanne".into()] }).unwrap();
        assert_eq!(both, suzanne);
        // A plain channel is clamped.
        let extra = read_matte_file(&path, &info, &MatteRequest::Channel("ViewLayer.Extra.mask".into())).unwrap();
        assert_eq!(extra[3 * 12 + 5], 0.25);
        // The pixel under a click names the object, or nothing.
        assert_eq!(crypto_name_at(&path, &info, &layer, 5, 3).unwrap().as_deref(), Some("Suzanne"));
        assert_eq!(crypto_name_at(&path, &info, &layer, 8, 3).unwrap(), None, "coverage 0 there");
        assert_eq!(crypto_name_at(&path, &info, &layer, 0, 0).unwrap(), None, "outside the data window");
        assert!(matches!(read_matte_file(&path, &info, &MatteRequest::Crypto { layer: "nope".into(), names: vec![] }), Err(IoError::Unsupported(_))));
    }

    /// The rendered fixture and the downloaded samples, when a path to a
    /// folder of them is given; the shape of each is what the
    /// render-pass tests record.
    #[test]
    fn real_files_when_present() {
        let Ok(dir) = std::env::var("HEELER_EXR_SAMPLES") else { return };
        let dir = std::path::Path::new(&dir);
        let read = |n: &str| std::fs::read(dir.join(n)).ok();
        if let Some(b) = read("heeler_passes.exr") {
            let info = inspect(&b).unwrap();
            assert!(info.world_to_camera.is_none(), "the fixture's renderer writes no camera");
            let path = dir.join("heeler_passes.exr");
            let objects = info.cryptomattes.iter().find(|c| c.layer.ends_with("CryptoObject")).unwrap();
            let m = read_matte_file(&path, &info, &MatteRequest::Crypto { layer: objects.layer.clone(), names: vec!["Suzanne".into()] }).unwrap();
            let covered = m.iter().filter(|v| **v > 0.0).count();
            let full = m.iter().filter(|v| **v >= 0.999).count();
            assert!(covered > full && full > 20_000, "{covered} touched, {full} full: anti-aliased edges");
            // The most covered pixel of the matte names Suzanne under a click.
            let (i, _) = m.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap();
            assert_eq!(crypto_name_at(&path, &info, &objects.layer, i % info.width, i / info.width).unwrap().as_deref(), Some("Suzanne"));
            assert!(matches!(&info.beauty, Beauty::Rgb { r, .. } if r == "ViewLayer.Combined.R"));
            assert_eq!(info.cryptomattes.len(), 2);
            assert!(info.cryptomattes.iter().any(|c| c.entries.iter().any(|e| e.name == "Suzanne")));
            let img = decode_beauty(&b).unwrap();
            assert!(img.data.chunks_exact(4).any(|p| p[0] > 1.0), "render highlights survive");
        }
        if let Some(b) = read("cornellBox_CryptoWildcard.0001.exr") {
            // The cornellBox sample: R, G, B are all zero in the file and the
            // room is in diffuse; the beauty decode stands in with it.
            let img = decode_beauty(&b).unwrap();
            assert!(img.data.chunks_exact(4).any(|p| p[0] > 0.1 || p[1] > 0.1), "the cornell box is lit from its diffuse layer");
        }
        if let Some(b) = read("bunny_CryptoObject.exr") {
            // Passes only: the un-numbered layer's colors are the picture.
            let img = decode_beauty(&b).unwrap();
            assert!(img.data.chunks_exact(4).any(|p| p[2] > 0.5), "bunny's Cryptomatte preview shows");
            assert!(img.data.chunks_exact(4).all(|p| p[..3].iter().all(|v| (0.0..=1.0).contains(v))));
        }
        if let Some(b) = read("multipart.0001.exr") {
            let info = inspect(&b).unwrap();
            assert_eq!(info.part, 0);
            assert_eq!((info.width, info.height), (2048, 1556));
            let img = decode_beauty(&b).unwrap();
            assert_eq!(img.pixel(0, 0)[3], 0.0, "outside the data window");
        }
        if let Some(b) = read("XYZ.exr") {
            let info = inspect(&b).unwrap();
            assert_eq!(info.primaries.known_name(), None);
            assert!(info.primaries.is_xyz());
            let img = decode_beauty(&b).unwrap();
            assert_eq!((img.width, img.height), (610, 406));
            assert!(img.data.iter().all(|v| v.is_finite()), "XYZ pixels convert without NaN");
        }
        if let Some(b) = read("bunny_CryptoObject.exr") {
            let info = inspect(&b).unwrap();
            assert_eq!(info.beauty, Beauty::None);
            assert!(info.cryptomattes[0].entries.iter().any(|e| e.name == "bunny"));
            assert_eq!(info.cryptomattes[0].ranks.len(), 6);
        }
        if let Some(b) = read("cornellBox_CryptoWildcard.0001.exr") {
            let info = inspect(&b).unwrap();
            assert!(matches!(&info.beauty, Beauty::Rgb { r, .. } if r == "R"));
            assert!(info.world_to_camera.is_some(), "the cornellBox renderer writes its camera");
            assert!(info.cryptomattes[0].entries.iter().any(|e| e.name.contains('*')));
        }
    }

    /// 26.3 Phase 3c: the layered writer's file comes back through this
    /// module's own reader: bare RGBA beauty, a mask as `<name>.A`, the
    /// depth as `depth.Z`, Rec. 709 primaries, and the `heeler` stamp.
    #[test]
    fn write_layers_round_trips_beauty_masks_and_depth() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("export.exr");
        let (w, h) = (4usize, 3usize);
        let px = w * h;
        let beauty: Vec<(String, Vec<f32>)> = ["R", "G", "B", "A"]
            .iter()
            .enumerate()
            .map(|(c, n)| (n.to_string(), (0..px).map(|i| i as f32 * 0.1 + c as f32).collect()))
            .collect();
        let mask: Vec<f32> = (0..px).map(|i| if i < 6 { 1.0 } else { 0.25 }).collect();
        let depth: Vec<f32> = (0..px).map(|i| 1.0 / (1.0 + i as f32)).collect();
        write_layers(&path, w, h, &[
            crate::exr_passes::Layer { name: String::new(), channels: beauty.clone() },
            crate::exr_passes::Layer { name: "sky".into(), channels: vec![(String::new(), mask.clone())] },
            crate::exr_passes::Layer { name: "depth".into(), channels: vec![("Z".to_string(), depth.clone())] },
        ])
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(is_exr(&bytes));
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.beauty, Beauty::Rgb { r: "R".into(), g: "G".into(), b: "B".into(), a: Some("A".into()) });
        assert_eq!(info.depth, Some(DepthChannel { name: "depth.Z".into(), metric: true }));
        assert_eq!(info.primaries.known_name(), Some("Rec. 709"));
        assert!(info.mattes.iter().any(|m| m == "sky"), "the bare mask channel reads as a matte: {:?}", info.mattes);
        // The stamp names the writer.
        let m = meta(&bytes).unwrap();
        let stamped = m.headers.iter().any(|h| text_attr(h, "heeler").is_some_and(|t| t.starts_with("Heeler ")));
        assert!(stamped, "the heeler attribute rides the header");
        // The planes round-trip: depth bit for bit (f32), color and the
        // mask within f16's step. Color sits in the file premultiplied
        // by the alpha beside it, the convention a compositor reads by.
        let planes = read_planes(&bytes, info.part, &["R", "G", "B", "A", "sky", "depth.Z"]).unwrap();
        for i in 0..px {
            let a = beauty[3].1[i];
            for c in 0..3 {
                let want = beauty[c].1[i] * a;
                // f16's step grows with the value: relative past 1.0.
                assert!((planes[c][i] - want).abs() < 0.002 * want.abs().max(1.0), "beauty ch{c} px{i}: {} vs {want} ({} over {a})", planes[c][i], beauty[c].1[i]);
            }
            assert!((planes[3][i] - a).abs() < 0.002, "alpha px{i}");
            assert!((planes[4][i] - mask[i]).abs() < 0.002, "mask px{i}: {} vs {}", planes[4][i], mask[i]);
            assert_eq!(planes[5][i], depth[i], "depth px{i} is f32, bit for bit");
        }
        // A bad plane is refused by name rather than truncated.
        let bad = crate::exr_passes::Layer { name: "x".into(), channels: vec![("A".to_string(), vec![0.0; 3])] };
        assert!(write_layers(&path, w, h, &[bad]).is_err());
    }

    /// 26.3 Phase 7: a Finish layer's blend mode, opacity and group ride
    /// the header as heeler.layer.<name>.* strings.
    #[test]
    fn layer_metadata_rides_the_header_as_strings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layers.exr");
        let (w, h) = (2usize, 2usize);
        let px = w * h;
        let beauty: Vec<(String, Vec<f32>)> = ["R", "G", "B", "A"]
            .iter()
            .map(|n| (n.to_string(), vec![0.5; px]))
            .collect();
        write_layers_with_attributes(
            &path,
            w,
            h,
            &[
                crate::exr_passes::Layer { name: String::new(), channels: beauty },
                crate::exr_passes::Layer {
                    name: "Paint 1".into(),
                    channels: ["R", "G", "B", "A"].iter().map(|n| (n.to_string(), vec![0.25; px])).collect(),
                },
            ],
            &[
                ("heeler.layer.Paint 1.mode".to_string(), "soft_light".to_string()),
                ("heeler.layer.Paint 1.opacity".to_string(), "80".to_string()),
            ],
        )
        .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let m = meta(&bytes).unwrap();
        let attr = |key: &str| m.headers.iter().find_map(|h| text_attr(h, key));
        assert_eq!(attr("heeler.layer.Paint 1.mode").as_deref(), Some("soft_light"));
        assert_eq!(attr("heeler.layer.Paint 1.opacity").as_deref(), Some("80"));
        let info = inspect(&bytes).unwrap();
        let planes = read_planes(&bytes, info.part, &["Paint 1.R", "Paint 1.A"]).unwrap();
        assert!((planes[0][0] - 0.25 * 0.25).abs() < 0.002, "the layer's pixels are in the file, premultiplied by their alpha: {}", planes[0][0]);
        assert!((planes[1][0] - 0.25).abs() < 0.002);
    }

    /// 26.3 Phase 7 import: the image layers of a layered file are its
    /// RGB groups minus the passes.
    #[test]
    fn image_layers_skip_the_beauty_and_the_passes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b.exr");
        view_layer_style(&path, None);
        let info = inspect_file(&path).unwrap();
        // Every group here is the beauty, a pass or a matte channel:
        // nothing to import as a picture.
        assert!(image_layers(&info).is_empty(), "{:?}", image_layers(&info));

        let path = dir.path().join("two.exr");
        let (w, h) = (4usize, 3usize);
        let px = w * h;
        let flat = |v: f32| vec![v; px];
        write_layers(&path, w, h, &[
            crate::exr_passes::Layer {
                name: String::new(),
                channels: ["R", "G", "B", "A"].iter().map(|n| (n.to_string(), flat(0.5))).collect(),
            },
            crate::exr_passes::Layer {
                name: "coat".into(),
                channels: ["R", "G", "B", "A"].iter().map(|n| (n.to_string(), flat(0.25))).collect(),
            },
            // A matte and a depth pass alongside: listed as neither.
            crate::exr_passes::Layer { name: "sky".into(), channels: vec![(String::new(), flat(1.0))] },
            crate::exr_passes::Layer { name: "depth".into(), channels: vec![("Z".to_string(), flat(2.0))] },
        ])
        .unwrap();
        let info = inspect_file(&path).unwrap();
        assert_eq!(image_layers(&info), vec!["coat".to_string()]);
    }

    /// 26.3 Phase 7 import: a named layer decodes like the beauty, in
    /// the working space, within half-float precision of what was
    /// written; an unknown name is an honest error.
    #[test]
    fn a_named_layer_decodes_within_half_float_precision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layers.exr");
        let (w, h) = (4usize, 3usize);
        let px = w * h;
        let coat: Vec<(String, Vec<f32>)> = ["R", "G", "B", "A"]
            .iter()
            .enumerate()
            .map(|(c, n)| (n.to_string(), (0..px).map(|i| i as f32 * 0.1 + c as f32).collect()))
            .collect();
        write_layers(&path, w, h, &[
            crate::exr_passes::Layer {
                name: String::new(),
                channels: ["R", "G", "B", "A"].iter().map(|n| (n.to_string(), vec![0.5; px])).collect(),
            },
            crate::exr_passes::Layer { name: "coat".into(), channels: coat.clone() },
        ])
        .unwrap();
        let img = decode_layer_file(&path, "coat").unwrap();
        assert_eq!((img.width, img.height), (w, h));
        for i in 0..px {
            for c in 0..4 {
                assert!(
                    (img.data[i * 4 + c] - coat[c].1[i]).abs() < 0.002,
                    "ch{c} px{i}: {} vs {}",
                    img.data[i * 4 + c],
                    coat[c].1[i]
                );
            }
        }
        // Case-insensitive on the leaves, exact on the layer name.
        assert!(decode_layer_file(&path, "nope").is_err());
    }

    /// Writes a layered fixture of odd sides with a ramp in every channel,
    /// returned as bytes with the ramp's values for checking.
    fn ramp_fixture(w: usize, h: usize) -> (Vec<u8>, Vec<(String, Vec<f32>)>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ramp.exr");
        let px = w * h;
        let beauty: Vec<(String, Vec<f32>)> = ["R", "G", "B", "A"]
            .iter()
            .enumerate()
            .map(|(c, n)| (n.to_string(), (0..px).map(|i| (i % 17) as f32 * 0.05 + c as f32 * 0.25).collect()))
            .collect();
        write_layers(&path, w, h, &[crate::exr_passes::Layer { name: String::new(), channels: beauty.clone() }]).unwrap();
        (std::fs::read(&path).unwrap(), beauty)
    }

    /// A reduced read is the box mean of the full read, cell by cell,
    /// with the ragged last column and row averaged over what is there.
    /// Odd sides on purpose: 9 by 7 at factor 2 is 5 by 4, at 4 it is
    /// 3 by 2.
    #[test]
    fn a_reduced_read_is_the_box_mean_of_the_full_read() {
        let (w, h) = (9usize, 7usize);
        let (bytes, _) = ramp_fixture(w, h);
        let full = read_planes(&bytes, 0, &["R", "G", "B", "A"]).unwrap();
        for factor in [2usize, 4] {
            let (rw, rh) = reduced_size(w, h, factor);
            assert_eq!((rw, rh), (w.div_ceil(factor), h.div_ceil(factor)));
            let reduced = read_planes_reduced(&bytes, 0, &["R", "G", "B", "A"], factor).unwrap();
            for (c, plane) in reduced.iter().enumerate() {
                assert_eq!(plane.len(), rw * rh, "factor {factor} plane {c} size");
                for ry in 0..rh {
                    for rx in 0..rw {
                        let (mut sum, mut n) = (0f32, 0usize);
                        for y in ry * factor..((ry + 1) * factor).min(h) {
                            for x in rx * factor..((rx + 1) * factor).min(w) {
                                sum += full[c][y * w + x];
                                n += 1;
                            }
                        }
                        let want = sum / n as f32;
                        let got = plane[ry * rw + rx];
                        assert!((got - want).abs() < 1e-3, "factor {factor} ch{c} ({rx},{ry}): {got} vs {want} over {n}");
                    }
                }
            }
        }
        assert_eq!(factor_for(4016, 6024, 2048), 3);
        assert_eq!(factor_for(4016, 6024, 1200), 6);
        assert_eq!(factor_for(960, 640, 2048), 1);
    }

    /// The reduced beauty is the reduced planes in the working space,
    /// alpha included, at the size the factor gives.
    #[test]
    fn the_reduced_beauty_matches_the_reduced_planes() {
        let (w, h) = (9usize, 7usize);
        let (bytes, _) = ramp_fixture(w, h);
        let img = decode_beauty_reduced(&bytes, 4).unwrap();
        assert_eq!((img.width, img.height), (3, 3));
        let planes = read_planes_reduced(&bytes, 0, &["R", "G", "B", "A"], 3).unwrap();
        for i in 0..9 {
            // The reduced planes are the file's premultiplied color and
            // its alpha; the picture holds the color straight.
            let a = planes[3][i];
            for c in 0..3 {
                let want = if a > 1e-6 && a != 1.0 { planes[c][i] / a } else { planes[c][i] };
                assert!((img.data[i * 4 + c] - want).abs() < 1e-4, "px{i} ch{c}: {} vs {want}", img.data[i * 4 + c]);
            }
            assert!((img.data[i * 4 + 3] - a).abs() < 1e-4, "px{i} alpha");
        }
        // Already small enough: the full picture, untouched.
        let img = decode_beauty_reduced(&bytes, 64).unwrap();
        assert_eq!((img.width, img.height), (w, h));
    }

    /// The beauty's own alpha is offered as a matte, since a photograph
    /// exported with a selection as its alpha wants it back as a mask.
    #[test]
    fn the_beauty_alpha_is_offered_as_a_matte() {
        let (bytes, _) = ramp_fixture(4, 3);
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.beauty, Beauty::Rgb { r: "R".into(), g: "G".into(), b: "B".into(), a: Some("A".into()) });
        assert!(info.mattes.iter().any(|m| m == "A"), "A is a matte: {:?}", info.mattes);
        assert!(!info.mattes.iter().any(|m| m == "R"), "the color channels are not: {:?}", info.mattes);
    }

    /// The decode reserves what it holds. Inside an empty boundary job
    /// (what every decode entry point opens) the old code measured the
    /// RGBA output against that empty reservation and refused a
    /// full-size render on a machine with memory to spare.
    #[test]
    fn the_beauty_decode_admits_its_own_memory() {
        let (bytes, _) = ramp_fixture(9, 7);
        memory::with_budget(64 << 20, || {
            let _boundary = Job::admit(0, "image work").unwrap();
            let img = decode_beauty(&bytes).unwrap();
            assert_eq!((img.width, img.height), (9, 7));
            let small = decode_beauty_reduced(&bytes, 4).unwrap();
            assert_eq!((small.width, small.height), (3, 3));
        });
        // And it is honest: a budget below the output refuses by name.
        memory::with_budget(256, || {
            let err = decode_beauty(&bytes).err().expect("refused").to_string();
            assert!(err.contains("Not enough memory"), "{err}");
        });
    }

    /// A multi-part file (several renderers and compositors write them) keeps its
    /// passes in parts of their own. Every flat part is described, the
    /// part's name is the layer prefix, and a read from the beauty's
    /// part resolves a name that lives in another (review, 2026-09-19).
    #[test]
    fn a_multi_part_file_offers_the_passes_of_every_part() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("multi.exr");
        let size = (6usize, 4usize);
        let ch = |name: &str, f: Box<dyn Fn(usize, usize) -> f32>| {
            AnyChannel::new(name, FlatSamples::F32((0..size.0 * size.1).map(|i| f(i % size.0, i / size.0)).collect()))
        };
        let rgba = ExrLayer::new(size, LayerAttributes::named("rgba"), Encoding::FAST_LOSSLESS, AnyChannels::sort(vec![
            ch("R", Box::new(|x, _| x as f32)), ch("G", Box::new(|_, y| y as f32)), ch("B", Box::new(|_, _| 0.5)), ch("A", Box::new(|_, _| 1.0)),
        ].into_iter().collect()));
        let depth = ExrLayer::new(size, LayerAttributes::named("depth"), Encoding::FAST_LOSSLESS, AnyChannels::sort(vec![
            ch("Z", Box::new(|x, _| 2.0 + x as f32)),
        ].into_iter().collect()));
        let mut crypto = ExrLayer::new(size, LayerAttributes::named("crypto"), Encoding::FAST_LOSSLESS, AnyChannels::sort(vec![
            ch("CryptoObject00.r", Box::new(|_, _| f32::from_bits(0xcb432898))),
            ch("CryptoObject00.g", Box::new(|x, _| if x < 3 { 1.0 } else { 0.0 })),
            ch("CryptoObject00.b", Box::new(|_, _| 0.0)),
            ch("CryptoObject00.a", Box::new(|_, _| 0.0)),
        ].into_iter().collect()));
        crypto.attributes.other.insert(Text::new_or_panic("cryptomatte/7a1/name"), AttributeValue::Text(Text::new_or_panic("CryptoObject")));
        crypto.attributes.other.insert(Text::new_or_panic("cryptomatte/7a1/manifest"), AttributeValue::Text(Text::new_or_panic(r#"{"Suzanne":"cb432898"}"#)));
        let parts: exr::image::Layers<AnyChannels<FlatSamples>> = vec![rgba, depth, crypto].into_iter().collect();
        let image = Image::from_layers(ImageAttributes::new(IntegerBounds::new(Vec2(0, 0), size)), parts);
        image.write().to_file(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.beauty, Beauty::Rgb { r: "rgba.R".into(), g: "rgba.G".into(), b: "rgba.B".into(), a: Some("rgba.A".into()) });
        assert_eq!(info.part, 0);
        assert_eq!(info.depth, Some(DepthChannel { name: "depth.Z".into(), metric: true }));
        assert_eq!(info.cryptomattes.len(), 1);
        assert_eq!(info.cryptomattes[0].ranks[0], ("crypto.CryptoObject00.r".to_string(), "crypto.CryptoObject00.g".to_string()));
        assert_eq!(info.cryptomattes[0].entries[0].name, "Suzanne");
        assert!(info.mattes.iter().any(|m| m == "rgba.A"), "{:?}", info.mattes);
        // A read from the beauty's part reaches the depth part by id.
        let planes = read_planes(&bytes, info.part, &["rgba.R", "depth.Z"]).unwrap();
        assert_eq!(planes[0][1], 1.0);
        assert_eq!(planes[1][3], 5.0);
        let matte = read_matte_file(&path, &info, &MatteRequest::Crypto { layer: "crypto.CryptoObject".into(), names: vec!["Suzanne".into()] }).unwrap();
        assert_eq!(matte[0], 1.0);
        assert_eq!(matte[4], 0.0);
        let beauty = decode_beauty(&bytes).unwrap();
        assert_eq!((beauty.width, beauty.height), size);
        assert_eq!(beauty.data[4 * 2], 2.0, "R at x=2");
    }

    /// A color layer's R, G and B are a picture, not three mattes; its
    /// alpha stays on the list.
    #[test]
    fn a_colour_layer_is_not_three_mattes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layers.exr");
        let plane = vec![0.5f32; 6];
        write_layers(&path, 3, 2, &[
            crate::exr_passes::Layer { name: String::new(), channels: vec![("R".into(), plane.clone()), ("G".into(), plane.clone()), ("B".into(), plane.clone())] },
            crate::exr_passes::Layer { name: "coat".into(), channels: vec![("R".into(), plane.clone()), ("G".into(), plane.clone()), ("B".into(), plane.clone()), ("A".into(), plane.clone())] },
            crate::exr_passes::Layer { name: "sky".into(), channels: vec![(String::new(), plane.clone())] },
        ]).unwrap();
        let info = inspect(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(info.mattes, vec!["coat.A".to_string(), "sky".to_string()]);
    }

    /// Heeler's depth goes out under the mist name and comes back as the
    /// farness it was, not inverted as a metric Z.
    #[test]
    fn heelers_depth_round_trips_as_farness() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mist.exr");
        let far: Vec<f32> = (0..6).map(|i| i as f32 / 5.0).collect();
        write_layers(&path, 3, 2, &[
            crate::exr_passes::Layer { name: String::new(), channels: vec![("R".into(), vec![0.5; 6]), ("G".into(), vec![0.5; 6]), ("B".into(), vec![0.5; 6])] },
            crate::exr_passes::Layer { name: "mist".into(), channels: vec![("Z".into(), far.clone())] },
        ]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let info = inspect(&bytes).unwrap();
        assert_eq!(info.depth, Some(DepthChannel { name: "mist.Z".into(), metric: false }));
        let planes = read_planes(&bytes, info.part, &["mist.Z"]).unwrap();
        assert_eq!(planes[0], far, "written as f32, bit for bit");
        assert_eq!(farness(&planes[0], false), far);
    }

    #[test]
    fn a_rejected_exr_write_keeps_the_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("existing.exr");
        std::fs::write(&path, b"previous export").unwrap();
        let layers = [crate::exr_passes::Layer {
            name: String::new(),
            channels: vec![("R".into(), vec![0.5; 2])],
        }];
        // Reserved attributes are rejected by the encoder, after our
        // own validation but before it writes the first byte.
        let result = write_layers_with_attributes(
            &path, 2, 1, &layers, &[("compression".into(), "invalid".into())],
        );
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"previous export");
    }

    /// A name outside Latin-1 is refused by name, not a panic inside
    /// the export.
    #[test]
    fn a_non_latin1_layer_name_is_refused_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("name.exr");
        let err = write_layers(&path, 2, 1, &[
            crate::exr_passes::Layer { name: String::new(), channels: vec![("R".into(), vec![0.5; 2]), ("G".into(), vec![0.5; 2]), ("B".into(), vec![0.5; 2])] },
            crate::exr_passes::Layer { name: "レイヤー 1".into(), channels: vec![(String::new(), vec![1.0; 2])] },
        ]).err().expect("refused").to_string();
        assert!(err.contains("Latin-1"), "{err}");
        assert!(!path.exists());
    }

    /// A Cryptomatte whose manifest lives in a `manif_file` sidecar
    /// beside the render (a compositor's way of keeping the header small) gets
    /// its names from there on a file read: the bytes-only inspect sees
    /// no names, the file inspect does, and the matte and the click
    /// resolve against them.
    #[test]
    fn a_manifest_in_a_sidecar_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("crypto_sidecar.exr");
        let px = 12usize;
        let flat = |v: f32| FlatSamples::F32(vec![v; px]);
        let channels = AnyChannels::sort(vec![
            AnyChannel::new("CryptoObject00.r", FlatSamples::F32(vec![f32::from_bits(0xcb432898); px])),
            AnyChannel::new("CryptoObject00.g", flat(1.0)),
            AnyChannel::new("CryptoObject00.b", flat(0.0)),
            AnyChannel::new("CryptoObject00.a", flat(0.0)),
        ].into_iter().collect());
        let mut layer = ExrLayer::new((4, 3), LayerAttributes::default(), Encoding::FAST_LOSSLESS, channels);
        layer.attributes.other.insert(Text::new_or_panic("cryptomatte/7a1/name"), AttributeValue::Text(Text::new_or_panic("CryptoObject")));
        layer.attributes.other.insert(Text::new_or_panic("cryptomatte/7a1/manif_file"), AttributeValue::Text(Text::new_or_panic("crypto_sidecar.manifest.json")));
        let mut image = Image::from_layer(layer);
        image.attributes = ImageAttributes::new(IntegerBounds::new(Vec2(0, 0), (4, 3)));
        image.write().to_file(&path).unwrap();
        std::fs::write(dir.path().join("crypto_sidecar.manifest.json"), r#"{"Suzanne":"cb432898"}"#).unwrap();

        let by_bytes = inspect(&std::fs::read(&path).unwrap()).unwrap();
        assert!(by_bytes.cryptomattes[0].entries.is_empty(), "the bytes alone carry no manifest");
        let info = inspect_file(&path).unwrap();
        assert_eq!(info.cryptomattes[0].entries, vec![CryptoEntry { name: "Suzanne".into(), hash: 0xcb432898 }]);
        let matte = read_matte_file(&path, &info, &MatteRequest::Crypto { layer: "CryptoObject".into(), names: vec!["Suzanne".into()] }).unwrap();
        assert_eq!(matte.iter().sum::<f32>(), px as f32, "every pixel covered");
        assert_eq!(crypto_name_at(&path, &info, "CryptoObject", 2, 1).unwrap().as_deref(), Some("Suzanne"));
    }

    /// The alpha convention, both ways: what Heeler writes is what a
    /// compositor merges by (premultiplied), what it reads comes back
    /// straight, and a round trip through its own file is exact. A pixel
    /// with no coverage keeps its stored color, since an additive
    /// element carries color under zero alpha on purpose.
    #[test]
    fn exr_alpha_is_premultiplied_in_the_file_and_straight_in_heeler() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("alpha.exr");
        // Straight values as Heeler holds them: a bright red at half
        // coverage, an opaque gray, a clear pixel, an additive glow.
        let straight = [([4.0f32, 1.0, 0.5], 0.5f32), ([0.5, 0.5, 0.5], 1.0), ([0.2, 0.3, 0.4], 0.0), ([0.0, 0.0, 0.0], 0.25)];
        let plane = |c: usize| straight.iter().map(|(rgb, _)| rgb[c]).collect::<Vec<f32>>();
        write_layers(&path, 4, 1, &[
            crate::exr_passes::Layer { name: String::new(), channels: vec![("R".into(), plane(0)), ("G".into(), plane(1)), ("B".into(), plane(2)), ("A".into(), straight.iter().map(|(_, a)| *a).collect())] },
            crate::exr_passes::Layer { name: "coat".into(), channels: vec![("R".into(), plane(0)), ("G".into(), plane(1)), ("B".into(), plane(2)), ("A".into(), straight.iter().map(|(_, a)| *a).collect())] },
            // A mask alone has no color to premultiply.
            crate::exr_passes::Layer { name: "sky".into(), channels: vec![("A".into(), vec![0.5; 4])] },
        ]).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        // The file holds premultiplied color: what a compositor's Merge and
        // a renderer's Alpha Over expect. Half float, so within its precision.
        let raw = read_planes(&bytes, 0, &["R", "A", "coat.R", "sky.A"]).unwrap();
        assert!((raw[0][0] - 2.0).abs() < 0.002, "R 4.0 at A 0.5 is stored as 2.0: {}", raw[0][0]);
        assert!((raw[0][1] - 0.5).abs() < 0.001, "opaque color is stored as it is");
        assert_eq!(raw[0][2], 0.0, "no coverage, no color in the file");
        assert!((raw[2][0] - 2.0).abs() < 0.002, "a named layer premultiplies too");
        assert_eq!(raw[3][0], 0.5, "a mask on its own is untouched");
        // Back in Heeler the color is straight again, the glow's zero
        // color included.
        let img = decode_beauty(&bytes).unwrap();
        let px = |x: usize| img.pixel(x, 0);
        assert!((px(0)[0] - 4.0).abs() < 0.004 && (px(0)[3] - 0.5).abs() < 0.001, "{:?}", px(0));
        assert!((px(1)[0] - 0.5).abs() < 0.001 && px(1)[3] == 1.0);
        assert_eq!(px(2), [0.0, 0.0, 0.0, 0.0], "a clear pixel comes back clear");
        assert!((px(3)[3] - 0.25).abs() < 0.001);
        let coat = decode_layer_file(&path, "coat").unwrap();
        assert!((coat.pixel(0, 0)[0] - 4.0).abs() < 0.004, "Layers from File unpremultiplies the same way: {:?}", coat.pixel(0, 0));
        // A renderer's file, premultiplied by hand: the edge reads at
        // its true color, not darkened by its own coverage.
        let rendered = dir.path().join("render.exr");
        let mut image = Image::from_layer(ExrLayer::new((2, 1), LayerAttributes::default(), Encoding::FAST_LOSSLESS, AnyChannels::sort(vec![
            AnyChannel::new("R", FlatSamples::F32(vec![0.066, 0.8])),
            AnyChannel::new("G", FlatSamples::F32(vec![0.033, 0.8])),
            AnyChannel::new("B", FlatSamples::F32(vec![0.0165, 0.8])),
            AnyChannel::new("A", FlatSamples::F32(vec![0.051, 1.0])),
        ].into_iter().collect())));
        image.attributes = ImageAttributes::new(IntegerBounds::new(Vec2(0, 0), (2, 1)));
        image.write().to_file(&rendered).unwrap();
        let edge = decode_beauty(&std::fs::read(&rendered).unwrap()).unwrap().pixel(0, 0);
        assert!((edge[0] - 0.066 / 0.051).abs() < 1e-4, "the edge's color is R/A: {:?}", edge);
        assert!((edge[3] - 0.051).abs() < 1e-6);
    }

    /// A file whose data window exceeds its display window is illegal
    /// and is refused in words that say so, not with the block reader's
    /// "invalid: decompressed data" from deep inside the decode.
    #[test]
    fn a_data_window_past_the_display_window_is_refused_in_words() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("windows.exr");
        write_layers(&path, 4, 3, &[crate::exr_passes::Layer {
            name: String::new(),
            channels: vec![("R".into(), vec![0.5; 12]), ("G".into(), vec![0.5; 12]), ("B".into(), vec![0.5; 12])],
        }])
        .unwrap();
        // Patch the dataWindow's xmax from 3 to 5: six columns against
        // the display window's four.
        let mut bytes = std::fs::read(&path).unwrap();
        let needle = b"dataWindow\0box2i\0";
        let at = bytes.windows(needle.len()).position(|w| w == needle).expect("dataWindow attribute") + needle.len() + 4;
        assert_eq!(i32::from_le_bytes(bytes[at + 8..at + 12].try_into().unwrap()), 3, "xmax as written");
        bytes[at + 8..at + 12].copy_from_slice(&5i32.to_le_bytes());
        let err = inspect(&bytes).err().expect("refused").to_string();
        assert!(err.contains("data window"), "{err}");
        let err = decode_beauty(&bytes).err().expect("refused").to_string();
        assert!(err.contains("data window"), "{err}");
    }
}
