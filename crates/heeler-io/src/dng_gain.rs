//! What a phone's DNG says to do with its pixels before anyone looks
//! at them.
//!
//! An iPhone ProRAW is a linear DNG whose pixels sit at whatever level
//! the camera's merge left them, and the file carries the rest of the
//! rendering as three tags: BaselineExposure (a per-photograph shift,
//! -2.6 to +4.6 stops across one real folder), ProfileGainTableMap (a
//! local tone map: a grid of gain curves that lifts the shadows and
//! pulls the highlights back under white) and ProfileToneCurve (the
//! contrast curve the tone map was made for). The three are one
//! instruction. Developed without them the salt flat of 2026-10-02
//! came out two stops over and the bridge in the forest four stops
//! under, beside thumbnails (the phone's own preview) that were right.
//!
//! LibRaw reads BaselineExposure and applies none of the three, so
//! this module does, after the develop: the gain map and the exposure
//! in scene-linear, then the curve. What comes out is the picture the
//! phone made, which is why such a file opens with the Tone Profile
//! bypassed, like any other rendered source.
//!
//! Not every phone writes all three. A Samsung Expert RAW carries the
//! exposure shift and the map and names no curve; the stage applies
//! what is there, and the file keeps the Tone Profile for the curve it
//! does not carry (`arrives_rendered`). A Pixel's file carries all
//! three and a ProfileLookTable besides, which this does not read, so
//! its color differs from the phone's more than an iPhone's does.
//!
//! A DNG without a gain table map is left alone. Its BaselineExposure
//! is a fraction of a stop, and the same camera's native RAW carries
//! no such tag, so honoring it would render a converted DNG and its
//! original differently.

use heeler_engine::ImageBuf;
use rayon::prelude::*;

use crate::dng_jxl::{get, Entry, Tiff};

const TAG_NEW_SUBFILE_TYPE: u16 = 254;
const TAG_ORIENTATION: u16 = 274;
const TAG_BASELINE_EXPOSURE: u16 = 50730;
const TAG_PROFILE_TONE_CURVE: u16 = 50940;
const TAG_PROFILE_GAIN_TABLE_MAP: u16 = 52525;

/// The fixed part of a ProfileGainTableMap, ahead of its gains: two
/// point counts, four doubles of spacing and origin, the table length
/// and five input weights.
const MAP_HEADER: usize = 64;

/// A DNG 1.6 ProfileGainTableMap: `points_v` by `points_h` gain curves
/// laid over the frame, each `points_n` gains long, looked up by a
/// weighted brightness of the pixel.
#[derive(Debug, Clone)]
pub struct GainTableMap {
    points_v: usize,
    points_h: usize,
    points_n: usize,
    /// Grid spacing and origin as shares of the frame's height and width.
    spacing_v: f64,
    spacing_h: f64,
    origin_v: f64,
    origin_h: f64,
    /// Weights on red, green, blue, the least and the greatest of them.
    weights: [f32; 5],
    /// Row by row, point by point, table entry by table entry.
    gains: Vec<f32>,
}

/// The rendering a DNG carries beside its pixels.
#[derive(Debug, Clone)]
pub struct FileRendering {
    /// BaselineExposure, in stops.
    pub baseline_exposure: f32,
    pub map: GainTableMap,
    /// ProfileToneCurve as (input, output) pairs, linear both ways,
    /// ascending. Empty when the file names none.
    pub tone_curve: Vec<(f32, f32)>,
    /// The file's orientation tag: the map is laid over the sensor's
    /// frame, the develop arrives turned upright.
    orientation: u16,
}

fn f32_at(bytes: &[u8], at: usize, little: bool) -> Option<f32> {
    let b = bytes.get(at..at + 4)?;
    let a = [b[0], b[1], b[2], b[3]];
    Some(if little { f32::from_le_bytes(a) } else { f32::from_be_bytes(a) })
}

fn u32_at(bytes: &[u8], at: usize, little: bool) -> Option<u32> {
    let b = bytes.get(at..at + 4)?;
    let a = [b[0], b[1], b[2], b[3]];
    Some(if little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
}

fn f64_at(bytes: &[u8], at: usize, little: bool) -> Option<f64> {
    let b = bytes.get(at..at + 8)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(b);
    Some(if little { f64::from_le_bytes(a) } else { f64::from_be_bytes(a) })
}

impl GainTableMap {
    /// Reads the tag's bytes in one byte order. None unless the header
    /// describes exactly the gains that follow it, which is also how
    /// the wrong byte order is told from the right one.
    fn parse(data: &[u8], little: bool) -> Option<Self> {
        let points_v = u32_at(data, 0, little)? as usize;
        let points_h = u32_at(data, 4, little)? as usize;
        let spacing_v = f64_at(data, 8, little)?;
        let spacing_h = f64_at(data, 16, little)?;
        let origin_v = f64_at(data, 24, little)?;
        let origin_h = f64_at(data, 32, little)?;
        let points_n = u32_at(data, 40, little)? as usize;
        if points_v == 0 || points_h == 0 || points_n == 0 {
            return None;
        }
        let count = points_v.checked_mul(points_h)?.checked_mul(points_n)?;
        if data.len() != MAP_HEADER.checked_add(count.checked_mul(4)?)? {
            return None;
        }
        if ![spacing_v, spacing_h, origin_v, origin_h].iter().all(|v| v.is_finite()) {
            return None;
        }
        let mut weights = [0f32; 5];
        for (i, w) in weights.iter_mut().enumerate() {
            *w = f32_at(data, 44 + i * 4, little)?;
        }
        let mut gains = Vec::new();
        gains.try_reserve_exact(count).ok()?;
        for i in 0..count {
            let g = f32_at(data, MAP_HEADER + i * 4, little)?;
            gains.push(if g.is_finite() { g.max(0.0) } else { 1.0 });
        }
        Some(GainTableMap { points_v, points_h, points_n, spacing_v, spacing_h, origin_v, origin_h, weights, gains })
    }

    /// Where a share of the frame (0 at one edge, 1 at the other) falls
    /// on one axis of the grid: the lower point, the upper one, and how
    /// far between. Past the grid the edge curve holds.
    fn grid(at: f64, origin: f64, spacing: f64, points: usize) -> (usize, usize, f32) {
        if points < 2 || spacing <= 0.0 {
            return (0, 0, 0.0);
        }
        let g = ((at - origin) / spacing).clamp(0.0, (points - 1) as f64);
        let lo = (g.floor() as usize).min(points - 2);
        (lo, lo + 1, (g - lo as f64) as f32)
    }

    /// One curve's gain at a table position already scaled to its length.
    #[inline]
    fn table(&self, v: usize, h: usize, n0: usize, n1: usize, t: f32) -> f32 {
        let base = (v * self.points_h + h) * self.points_n;
        let a = self.gains[base + n0];
        a + (self.gains[base + n1] - a) * t
    }
}

/// The rendering this file carries, or None for anything that is not a
/// DNG with a gain table map. The tag is read in the file's byte order
/// and, failing that, the other: writers disagree, and a header that
/// does not add up to its own length says which was wrong.
pub fn file_rendering(bytes: &[u8]) -> Option<FileRendering> {
    let t = Tiff::new(bytes)?;
    let (ifd0, subs) = t.read_ifd(t.u32_at(4)? as usize)?;
    let map = gain_map_entry(&t, &ifd0, &subs).and_then(|e| {
        let data = bytes.get(e.at..e.at.checked_add(e.count as usize)?)?;
        GainTableMap::parse(data, t.little).or_else(|| GainTableMap::parse(data, !t.little))
    })?;
    let number = |tag: u16| get(&ifd0, tag).and_then(|e| t.number(e, 0));
    let baseline_exposure = number(TAG_BASELINE_EXPOSURE).filter(|v| v.is_finite()).unwrap_or(0.0) as f32;
    let orientation = number(TAG_ORIENTATION).unwrap_or(1.0) as u16;
    let tone_curve = get(&ifd0, TAG_PROFILE_TONE_CURVE).map(|e| tone_curve(&t, e)).unwrap_or_default();
    Some(FileRendering { baseline_exposure, map, tone_curve, orientation })
}

/// The gain table map's entry: the main image's own (subfile type 0)
/// when several directories carry one, the first found otherwise.
fn gain_map_entry(t: &Tiff, ifd0: &[(u16, Entry)], subs: &[usize]) -> Option<Entry> {
    let mut found = None;
    let directories = subs.iter().filter_map(|&at| t.read_ifd(at).map(|(entries, _)| entries));
    for entries in directories.chain(std::iter::once(ifd0.to_vec())) {
        let Some(e) = get(&entries, TAG_PROFILE_GAIN_TABLE_MAP) else { continue };
        let main = get(&entries, TAG_NEW_SUBFILE_TYPE).and_then(|s| t.number(s, 0)).unwrap_or(0.0) as u32 == 0;
        if main {
            return Some(*e);
        }
        found.get_or_insert(*e);
    }
    found
}

/// ProfileToneCurve's pairs, kept only when they are a curve: finite,
/// at least two, inputs never stepping back.
fn tone_curve(t: &Tiff, e: &Entry) -> Vec<(f32, f32)> {
    let values = t.numbers(e);
    let pairs: Vec<(f32, f32)> = values.chunks_exact(2).map(|p| (p[0] as f32, p[1] as f32)).collect();
    let sound = pairs.len() >= 2
        && pairs.iter().all(|(x, y)| x.is_finite() && y.is_finite())
        && pairs.windows(2).all(|w| w[1].0 >= w[0].0);
    if sound { pairs } else { Vec::new() }
}

/// Whether the DNG at `path` carries a gain table map, read from its
/// directories alone: a listing asks this of every DNG it shows, and
/// the map itself is megabytes nobody needs for the answer.
pub fn carries_gain_table_map(path: &std::path::Path) -> bool {
    rendering_tags(path).0
}

/// Whether the DNG at `path` arrives as a finished picture: a gain
/// table map AND a tone curve of its own. An iPhone's and a Pixel's
/// files carry both, and the decode leaves nothing for the Tone
/// Profile to add, so they open with it bypassed. A Samsung Expert
/// RAW carries the exposure shift and the map and names no curve: the
/// DNG default then is the renderer's own curve, which here is the
/// Tone Profile, so such a file keeps it. Measured on five Galaxy
/// files against their embedded previews (2026-10-03, cell means in
/// display levels): map and profile +5, -32, -61, +5, +2; the map with
/// the profile off -30, -60, -72, -4, -35; neither, as 26.4.0 showed
/// them, -83, -109, -96, -27, -55.
pub fn arrives_rendered(path: &std::path::Path) -> bool {
    rendering_tags(path) == (true, true)
}

/// (carries a gain table map, names a tone curve), from the file's
/// directories alone. The curve is the first directory's, where
/// `file_rendering` reads it.
fn rendering_tags(path: &std::path::Path) -> (bool, bool) {
    use std::io::{Read, Seek, SeekFrom};
    let none = (false, false);
    let Ok(mut file) = std::fs::File::open(path) else { return none };
    let mut head = [0u8; 8];
    if file.read_exact(&mut head).is_err() {
        return none;
    }
    let little = match &head[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return none,
    };
    let u16_of = |b: &[u8]| if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) };
    let u32_of = |b: &[u8]| {
        let a = [b[0], b[1], b[2], b[3]];
        if little { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) }
    };
    if u16_of(&head[2..4]) != 42 {
        return none;
    }
    // One directory's entries, twelve bytes each.
    let directory = |file: &mut std::fs::File, at: u64| -> Option<Vec<u8>> {
        file.seek(SeekFrom::Start(at)).ok()?;
        let mut count = [0u8; 2];
        file.read_exact(&mut count).ok()?;
        let mut entries = vec![0u8; u16_of(&count) as usize * 12];
        file.read_exact(&mut entries).ok()?;
        Some(entries)
    };
    let Some(first) = directory(&mut file, u32_of(&head[4..8]) as u64) else { return none };
    let mut map = false;
    let mut curve = false;
    let mut subs: Vec<u64> = Vec::new();
    for e in first.chunks_exact(12) {
        match u16_of(&e[0..2]) {
            TAG_PROFILE_GAIN_TABLE_MAP => map = true,
            // Two pairs at least, as `tone_curve` asks.
            TAG_PROFILE_TONE_CURVE => curve = u32_of(&e[4..8]) >= 4,
            // SubIFDs: one offset sits in the entry, more sit out of line.
            330 => {
                let n = u32_of(&e[4..8]) as usize;
                if n == 1 {
                    subs.push(u32_of(&e[8..12]) as u64);
                } else if n <= 16 {
                    let mut offsets = vec![0u8; n * 4];
                    let read = file
                        .seek(SeekFrom::Start(u32_of(&e[8..12]) as u64))
                        .and_then(|_| file.read_exact(&mut offsets));
                    if read.is_ok() {
                        subs.extend(offsets.chunks_exact(4).map(|o| u32_of(o) as u64));
                    }
                }
            }
            _ => {}
        }
    }
    let map = map
        || subs.into_iter().any(|at| {
            directory(&mut file, at).is_some_and(|d| d.chunks_exact(12).any(|e| u16_of(&e[0..2]) == TAG_PROFILE_GAIN_TABLE_MAP))
        });
    (map, curve)
}

/// The share of the sensor's frame (across, down) that a share of the
/// upright picture came from: the turn `apply_orientation` and LibRaw
/// make, undone.
fn sensor_position(orientation: u16, x: f64, y: f64) -> (f64, f64) {
    match orientation {
        2 => (1.0 - x, y),
        3 => (1.0 - x, 1.0 - y),
        4 => (x, 1.0 - y),
        5 => (y, x),
        6 => (y, 1.0 - x),
        7 => (1.0 - y, 1.0 - x),
        8 => (1.0 - y, x),
        _ => (x, y),
    }
}

/// The curve at `x`, linear between its pairs and held past its ends.
fn curve_at(curve: &[(f32, f32)], x: f32) -> f32 {
    let (first, last) = (curve[0], curve[curve.len() - 1]);
    if x <= first.0 {
        return first.1;
    }
    if x >= last.0 {
        return last.1;
    }
    let hi = curve.partition_point(|p| p.0 <= x).min(curve.len() - 1);
    let (a, b) = (curve[hi - 1], curve[hi]);
    if b.0 <= a.0 {
        return b.1;
    }
    a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0)
}

/// Renders a developed frame the way its file says: the gain map
/// looked up by the pixel's weighted brightness after the exposure
/// shift, the gain and the shift applied, then the tone curve. `img`
/// is the upright, scene-linear develop of the whole frame, at any
/// size: the map is laid out in shares of the frame.
///
/// The weights and the curve read the working space's own channels
/// (linear, sRGB primaries), on purpose. The DNG SDK's reference
/// renderer evaluates both in linear ProPhoto, and the 26.4.1 review
/// moved this stage there; measured over the owner's 82 files against
/// the phone's embedded previews, that was the worse match, and the
/// goal here is the phone's picture (2026-10-02: "match the
/// thumbnail"), not a RAW editor's. Cell means in display levels, luma
/// then colorfulness (examples/gainprobe.rs):
///
/// - weights and curve here: luma spread 1.73 (worst 5.2), bias -5.7
///   to +13.5; color spread 3.44 (worst 10.8)
/// - both in ProPhoto: luma spread 1.97 (worst 6.6), bias -11.5 to
///   +13.9; color spread 3.35 (worst 12.7)
/// - weights here, curve in ProPhoto: luma 1.73 (5.5), bias -11.5 to
///   +13.4; color 3.36 (12.5)
///
/// The weights are the clearer half: an iPhone writes Rec.709's luma
/// coefficients into its map, which only weigh luminance on these
/// primaries. The curve is close to a tie on average and worse at its
/// worst in ProPhoto (a saturated aurora came out a stop deeper than
/// the phone's), so it stays here too. The table index and the clamp
/// before the curve do follow the SDK.
///
/// The curve goes on the greatest and the least channel and the middle
/// one keeps its place between them, which holds the hue where a curve
/// per channel would bend it (the DNG reference renderer's rule).
pub fn render(img: &mut ImageBuf, r: &FileRendering) {
    let (w, h) = (img.width, img.height);
    if w == 0 || h == 0 {
        return;
    }
    let map = &r.map;
    let exposure = r.baseline_exposure.exp2();
    // The SDK scales by the table length, then holds the final entry.
    let table_size = map.points_n as f32;
    img.data.par_chunks_exact_mut(w * 4).enumerate().for_each(|(y, row)| {
        let fy = (y as f64 + 0.5) / h as f64;
        for (x, px) in row.chunks_exact_mut(4).enumerate() {
            let fx = (x as f64 + 0.5) / w as f64;
            let (sx, sy) = sensor_position(r.orientation, fx, fy);
            let (v0, v1, tv) = GainTableMap::grid(sy, map.origin_v, map.spacing_v, map.points_v);
            let (h0, h1, th) = GainTableMap::grid(sx, map.origin_h, map.spacing_h, map.points_h);
            let (red, green, blue) = (px[0].max(0.0), px[1].max(0.0), px[2].max(0.0));
            let least = red.min(green).min(blue);
            let greatest = red.max(green).max(blue);
            let weight = (map.weights[0] * red
                + map.weights[1] * green
                + map.weights[2] * blue
                + map.weights[3] * least
                + map.weights[4] * greatest)
                * exposure;
            let n = weight.clamp(0.0, 1.0) * table_size;
            let n0 = (n as usize).min(map.points_n - 1);
            let n1 = (n0 + 1).min(map.points_n - 1);
            let tn = n - n0 as f32;
            let upper = map.table(v0, h0, n0, n1, tn) * (1.0 - th) + map.table(v0, h1, n0, n1, tn) * th;
            let lower = map.table(v1, h0, n0, n1, tn) * (1.0 - th) + map.table(v1, h1, n0, n1, tn) * th;
            let gain = (upper * (1.0 - tv) + lower * tv) * exposure;
            let mut out = [red * gain, green * gain, blue * gain];
            if !r.tone_curve.is_empty() {
                out = toned(out, &r.tone_curve);
            }
            px[0] = out[0];
            px[1] = out[1];
            px[2] = out[2];
        }
    });
}

/// The tone curve on one pixel, hue held: the greatest and least
/// channels take the curve, the middle one keeps its share of the way
/// between them.
fn toned(px: [f32; 3], curve: &[(f32, f32)]) -> [f32; 3] {
    let px = px.map(|c| c.clamp(0.0, 1.0));
    let greatest = px[0].max(px[1]).max(px[2]);
    let least = px[0].min(px[1]).min(px[2]);
    let (hi, lo) = (curve_at(curve, greatest), curve_at(curve, least));
    if greatest - least <= f32::EPSILON {
        return [hi, hi, hi];
    }
    let scale = (hi - lo) / (greatest - least);
    [lo + (px[0] - least) * scale, lo + (px[1] - least) * scale, lo + (px[2] - least) * scale]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One directory entry: tag, type, count and the value's bytes
    /// already in the file's byte order.
    type Field = (u16, u16, u32, Vec<u8>);

    fn put16(little: bool, v: u16) -> [u8; 2] {
        if little { v.to_le_bytes() } else { v.to_be_bytes() }
    }
    fn put32(little: bool, v: u32) -> [u8; 4] {
        if little { v.to_le_bytes() } else { v.to_be_bytes() }
    }
    fn putf(little: bool, v: f32) -> [u8; 4] {
        if little { v.to_le_bytes() } else { v.to_be_bytes() }
    }
    fn putd(little: bool, v: f64) -> [u8; 8] {
        if little { v.to_le_bytes() } else { v.to_be_bytes() }
    }

    /// A directory at `at`: its entries, then the values too long to
    /// sit in them.
    fn directory(little: bool, at: usize, fields: &[Field]) -> Vec<u8> {
        let mut fields = fields.to_vec();
        fields.sort_by_key(|f| f.0);
        let mut out = put16(little, fields.len() as u16).to_vec();
        let mut values: Vec<u8> = Vec::new();
        let values_at = at + 2 + fields.len() * 12 + 4;
        for (tag, kind, count, payload) in &fields {
            out.extend(put16(little, *tag));
            out.extend(put16(little, *kind));
            out.extend(put32(little, *count));
            if payload.len() <= 4 {
                let mut inline = payload.clone();
                inline.resize(4, 0);
                out.extend(inline);
            } else {
                out.extend(put32(little, (values_at + values.len()) as u32));
                values.extend(payload);
            }
        }
        out.extend([0u8; 4]);
        out.extend(values);
        out
    }

    /// A TIFF of directories only, which is all this module reads: the
    /// first one and, when given, a SubIFD it points at.
    fn tiff(little: bool, first: &[Field], sub: Option<&[Field]>) -> Vec<u8> {
        let mut out = if little { b"II".to_vec() } else { b"MM".to_vec() };
        out.extend(put16(little, 42));
        out.extend(put32(little, 8));
        let Some(sub) = sub else {
            out.extend(directory(little, 8, first));
            return out;
        };
        // The SubIFD's offset is one inline LONG, so its value does not
        // move the first directory's length.
        let mut fields = first.to_vec();
        fields.push((330, 4, 1, put32(little, 0).to_vec()));
        let sub_at = 8 + directory(little, 8, &fields).len();
        fields.last_mut().unwrap().3 = put32(little, sub_at as u32).to_vec();
        out.extend(directory(little, 8, &fields));
        out.extend(directory(little, sub_at, sub));
        out
    }

    /// A gain table map's bytes: `gain(v, h, n)` at every point.
    fn map_bytes(little: bool, v: usize, h: usize, n: usize, weights: [f32; 5], gain: impl Fn(usize, usize, usize) -> f32) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend(put32(little, v as u32));
        out.extend(put32(little, h as u32));
        // Points on the cell centers of an even grid, as a phone lays them.
        out.extend(putd(little, 1.0 / v as f64));
        out.extend(putd(little, 1.0 / h as f64));
        out.extend(putd(little, 0.5 / v as f64));
        out.extend(putd(little, 0.5 / h as f64));
        out.extend(put32(little, n as u32));
        for w in weights {
            out.extend(putf(little, w));
        }
        for vi in 0..v {
            for hi in 0..h {
                for ni in 0..n {
                    out.extend(putf(little, gain(vi, hi, ni)));
                }
            }
        }
        out
    }

    fn map_field(bytes: Vec<u8>) -> Field {
        (TAG_PROFILE_GAIN_TABLE_MAP, 7, bytes.len() as u32, bytes)
    }

    fn baseline(little: bool, stops: f32) -> Field {
        let mut v = put32(little, (stops * 1000.0).round() as i32 as u32).to_vec();
        v.extend(put32(little, 1000));
        (TAG_BASELINE_EXPOSURE, 10, 1, v)
    }

    fn curve_field(little: bool, pairs: &[(f32, f32)]) -> Field {
        let mut v = Vec::new();
        for (x, y) in pairs {
            v.extend(putf(little, *x));
            v.extend(putf(little, *y));
        }
        (TAG_PROFILE_TONE_CURVE, 11, (pairs.len() * 2) as u32, v)
    }

    /// Luma weights that put a mid-gray of 0.5 halfway along the table.
    const LUMA: [f32; 5] = [0.2126, 0.7152, 0.0722, 0.0, 0.0];

    fn flat(w: usize, h: usize, v: f32) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for px in img.data.chunks_exact_mut(4) {
            px.copy_from_slice(&[v, v, v, 1.0]);
        }
        img
    }

    #[test]
    fn a_dng_without_a_gain_table_map_carries_no_rendering() {
        // A camera's DNG has a baseline exposure and no map, and is
        // developed as it always was.
        let file = tiff(true, &[baseline(true, 0.35)], None);
        assert!(file_rendering(&file).is_none());
        assert!(file_rendering(b"not a tiff").is_none());
        assert!(file_rendering(&[]).is_none());
    }

    #[test]
    fn the_rendering_is_read_from_the_main_images_directory() {
        // An iPhone keeps the map in the raw SubIFD and the exposure and
        // curve in the first directory, in a big-endian file.
        let map = map_bytes(false, 2, 3, 5, LUMA, |v, h, n| (v * 100 + h * 10 + n) as f32);
        let file = tiff(
            false,
            &[baseline(false, 3.677), curve_field(false, &[(0.0, 0.0), (0.5, 0.25), (1.0, 1.0)]), (TAG_ORIENTATION, 3, 1, put16(false, 6).to_vec())],
            Some(&[(TAG_NEW_SUBFILE_TYPE, 4, 1, put32(false, 0).to_vec()), map_field(map)]),
        );
        let r = file_rendering(&file).expect("the map is in the SubIFD");
        assert!((r.baseline_exposure - 3.677).abs() < 1e-3);
        assert_eq!(r.orientation, 6);
        assert_eq!(r.tone_curve, vec![(0.0, 0.0), (0.5, 0.25), (1.0, 1.0)]);
        assert_eq!((r.map.points_v, r.map.points_h, r.map.points_n), (2, 3, 5));
        assert_eq!(r.map.weights, LUMA);
        assert_eq!(r.map.gains.len(), 30);
        assert_eq!(r.map.gains[(3 + 2) * 5 + 4], 124.0);
    }

    #[test]
    fn a_map_written_in_the_other_byte_order_still_reads() {
        // Writers disagree on whether the tag follows the file's byte
        // order. A header that does not add up to its own length says
        // which was wrong.
        let map = map_bytes(false, 1, 1, 4, LUMA, |_, _, n| n as f32);
        let file = tiff(true, &[map_field(map)], None);
        let r = file_rendering(&file).expect("the other order is tried");
        assert_eq!(r.map.gains, vec![0.0, 1.0, 2.0, 3.0]);
        // A map whose length disagrees with its header in both orders
        // is not a map.
        let mut short = map_bytes(true, 1, 1, 4, LUMA, |_, _, n| n as f32);
        short.truncate(short.len() - 4);
        assert!(file_rendering(&tiff(true, &[map_field(short)], None)).is_none());
    }

    #[test]
    fn the_weights_read_the_working_spaces_own_channels() {
        // Not the SDK's ProPhoto (see `render`): a map weighing red
        // alone looks up this pixel by its sRGB-primaries red, 0.1,
        // which in a three-entry table is index 0.3, gain 1.7. In
        // ProPhoto its red would be 0.359 and the gain 0.96.
        let map = map_bytes(true, 1, 1, 3, [1.0, 0.0, 0.0, 0.0, 0.0], |_, _, n| [2.0, 1.0, 0.5][n]);
        let r = file_rendering(&tiff(true, &[map_field(map)], None)).unwrap();
        let mut img = ImageBuf::new(1, 1);
        img.set_pixel(0, 0, [0.1, 0.8, 0.3, 1.0]);
        render(&mut img, &r);
        assert!((img.data[0] - 0.17).abs() < 1e-5, "{}", img.data[0]);
        assert!((img.data[1] - 1.36).abs() < 1e-5, "{}", img.data[1]);
        assert!((img.data[2] - 0.51).abs() < 1e-5, "{}", img.data[2]);
    }

    #[test]
    fn sdk_tone_clamps_channels_before_interpolating_the_middle() {
        let out = toned([1.5, 0.8, 0.2], &[(0.0, 0.0), (0.5, 0.25), (1.0, 1.0)]);
        // Reference input is [1, .8, .2], so the middle lies .75 of
        // the way from the mapped minimum .1 to the maximum 1.
        assert!((out[1] - 0.775).abs() < 1e-6, "{}", out[1]);
    }

    #[test]
    fn sdk_gain_table_uses_the_table_length_for_its_input_index() {
        // SDK reference: a 0.5 lookup in a three-entry table is index
        // 1.5, between gains 1.25 and 0.5. Exposure also reaches RGB.
        let map = map_bytes(true, 1, 1, 3, LUMA, |_, _, n| [2.0, 1.25, 0.5][n]);
        let r = file_rendering(&tiff(true, &[baseline(true, 1.0), map_field(map)], None)).unwrap();
        let mut img = flat(1, 1, 0.25);
        render(&mut img, &r);
        assert!((img.data[0] - 0.4375).abs() < 1e-6, "SDK output 0.4375, got {}", img.data[0]);
    }

    #[test]
    fn the_gain_is_looked_up_after_the_exposure_shift_and_both_apply() {
        // One curve for the whole frame: gain 2 at the dark end of the
        // table falling to 0.5 at the bright end. A pixel of 0.25 under
        // a baseline of +1 stop is looked up at 0.5 * 3 = 1.5: gain 0.875.
        // It leaves as 0.25 times the gain times the exposure.
        let map = map_bytes(true, 1, 1, 3, LUMA, |_, _, n| [2.0, 1.25, 0.5][n]);
        let r = file_rendering(&tiff(true, &[baseline(true, 1.0), map_field(map)], None)).unwrap();
        let mut img = flat(4, 4, 0.25);
        render(&mut img, &r);
        for px in img.data.chunks_exact(4) {
            assert!((px[0] - 0.25 * 0.875 * 2.0).abs() < 1e-5, "got {}", px[0]);
            assert_eq!(px[3], 1.0);
        }
        // Past the table's end the last gain holds: 0.9 under +1 stop
        // is looked up at 1.0.
        let mut bright = flat(2, 2, 0.9);
        render(&mut bright, &r);
        assert!((bright.data[0] - 0.9 * 0.5 * 2.0).abs() < 1e-5);
    }

    #[test]
    fn the_map_follows_the_sensor_when_the_picture_is_turned() {
        // Two curves side by side on the sensor: the left half's gain
        // is 1, the right half's 3. Upright (orientation 1) that is the
        // picture's left and right. Turned a quarter clockwise
        // (orientation 6, a phone held upright) the sensor's left is
        // the picture's top, so the gains run top to bottom.
        let map = || map_bytes(true, 1, 2, 1, LUMA, |_, h, _| [1.0, 3.0][h]);
        let upright = file_rendering(&tiff(true, &[map_field(map())], None)).unwrap();
        let mut img = flat(8, 8, 0.1);
        render(&mut img, &upright);
        assert!((img.pixel(0, 4)[0] - 0.1).abs() < 1e-5);
        assert!((img.pixel(7, 4)[0] - 0.3).abs() < 1e-5);
        assert!((img.pixel(0, 0)[0] - img.pixel(0, 7)[0]).abs() < 1e-6);

        let turned = file_rendering(&tiff(true, &[(TAG_ORIENTATION, 3, 1, put16(true, 6).to_vec()), map_field(map())], None)).unwrap();
        let mut img = flat(8, 8, 0.1);
        render(&mut img, &turned);
        assert!((img.pixel(4, 0)[0] - 0.1).abs() < 1e-5);
        assert!((img.pixel(4, 7)[0] - 0.3).abs() < 1e-5);
        assert!((img.pixel(0, 0)[0] - img.pixel(7, 0)[0]).abs() < 1e-6);
        // And the turn agrees with the one the decoders make: a sensor
        // frame marked at its left edge, turned by apply_orientation,
        // carries the mark where sensor_position says the left edge is.
        for orientation in 1..=8u16 {
            let mut sensor = ImageBuf::new(8, 6);
            for y in 0..6 {
                for x in 0..8 {
                    sensor.set_pixel(x, y, [x as f32, y as f32, 0.0, 1.0]);
                }
            }
            let up = crate::apply_orientation(sensor, orientation);
            for y in 0..up.height {
                for x in 0..up.width {
                    let (sx, sy) = sensor_position(orientation, (x as f64 + 0.5) / up.width as f64, (y as f64 + 0.5) / up.height as f64);
                    let from = up.pixel(x, y);
                    assert_eq!(((sx * 8.0).floor() as f32, (sy * 6.0).floor() as f32), (from[0], from[1]), "orientation {orientation}");
                }
            }
        }
    }

    #[test]
    fn the_tone_curve_follows_the_gain_and_holds_the_hue() {
        // No gain to speak of (a map of ones), then a curve that halves
        // everything below one half.
        let map = map_bytes(true, 1, 1, 1, LUMA, |_, _, _| 1.0);
        let curve = [(0.0, 0.0), (0.5, 0.25), (1.0, 1.0)];
        let r = file_rendering(&tiff(true, &[curve_field(true, &curve), map_field(map)], None)).unwrap();
        let mut gray = flat(2, 2, 0.5);
        render(&mut gray, &r);
        assert!((gray.data[0] - 0.25).abs() < 1e-6);
        // A color: the greatest and least channels take the curve, the
        // middle one keeps its share of the way between them.
        let mut img = ImageBuf::new(1, 1);
        img.set_pixel(0, 0, [0.5, 0.3, 0.1, 1.0]);
        render(&mut img, &r);
        let px = img.pixel(0, 0);
        assert!((px[0] - 0.25).abs() < 1e-6);
        assert!((px[2] - 0.05).abs() < 1e-6);
        assert!((px[1] - 0.15).abs() < 1e-6, "the middle channel sits halfway, got {}", px[1]);
        // A file naming no curve gets the gain and the exposure alone.
        let bare = file_rendering(&tiff(true, &[map_field(map_bytes(true, 1, 1, 1, LUMA, |_, _, _| 1.0))], None)).unwrap();
        assert!(bare.tone_curve.is_empty());
        let mut same = flat(2, 2, 0.5);
        render(&mut same, &bare);
        assert_eq!(same.data[0], 0.5);
    }

    #[test]
    fn a_listing_finds_the_map_from_the_directories_alone() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, bytes: Vec<u8>| {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).unwrap();
            path
        };
        let map = || map_field(map_bytes(false, 1, 1, 2, LUMA, |_, _, _| 1.0));
        let in_sub = write("phone.dng", tiff(false, &[baseline(false, 1.0)], Some(&[map()])));
        let in_first = write("first.dng", tiff(true, &[map_field(map_bytes(true, 1, 1, 2, LUMA, |_, _, _| 1.0))], None));
        let camera = write("camera.dng", tiff(true, &[baseline(true, 0.35)], Some(&[(TAG_NEW_SUBFILE_TYPE, 4, 1, put32(true, 0).to_vec())])));
        let junk = write("junk.dng", b"no directories here".to_vec());
        assert!(carries_gain_table_map(&in_sub));
        assert!(carries_gain_table_map(&in_first));
        assert!(!carries_gain_table_map(&camera));
        assert!(!carries_gain_table_map(&junk));
        assert!(!carries_gain_table_map(&dir.path().join("missing.dng")));
        // A file with the map and a curve arrives rendered; one with the
        // map alone (a Samsung Expert RAW) is rendered by its map and
        // still wants the Tone Profile; a curve without a map is a
        // camera profile's, nothing of ours.
        let curve = || curve_field(false, &[(0.0, 0.0), (1.0, 1.0)]);
        let finished = write("finished.dng", tiff(false, &[baseline(false, 1.0), curve()], Some(&[map()])));
        let curve_only = write("curve.dng", tiff(false, &[curve()], None));
        assert!(arrives_rendered(&finished));
        assert!(!arrives_rendered(&in_sub) && carries_gain_table_map(&in_sub));
        assert!(!arrives_rendered(&curve_only) && !carries_gain_table_map(&curve_only));
        assert!(!arrives_rendered(&camera) && !arrives_rendered(&junk));
        assert!(file_rendering(&std::fs::read(&in_sub).unwrap()).is_some_and(|r| r.tone_curve.is_empty()));
        // The listing's answer and the decode's are one answer.
        for path in [&in_sub, &in_first, &camera] {
            assert_eq!(carries_gain_table_map(path), file_rendering(&std::fs::read(path).unwrap()).is_some());
        }
    }
}
