//! DNG GainMap opcodes (opcode 9 in OpcodeList2), applied to the sensor
//! data before the develop: by heeler-raw to LibRaw's unpacked data, and
//! by this crate's develop to its own.
//!
//! A phone corrects its lens shading this way: one smooth map of gains
//! per CFA color, which the reader must multiply into the linear sensor
//! values (black subtracted) before demosaicing. LibRaw reads the
//! opcode lists but applies only MapPolynomial, and only in its lossy
//! DNG reader. So without this the corners of a Pixel photograph stay as
//! dark, and as tinted, as the sensor saw them: the Pixel 3a's maps reach
//! 3.4 at the corners.
//!
//! Only GainMap is read; every other opcode in the list is skipped, as
//! are maps on a plane a single-plane CFA image does not have. The map
//! is a grid over the whole stage 2 image (the active area): a pixel's
//! position as a fraction of the image's height and width, less the
//! map's origin, over its spacing, is its place in the grid, clamped to
//! the grid's edges and read bilinearly.
//!
//! OpcodeList3 is applied after demosaic, to the camera's own colors
//! (stage 3), and drones and iPhones put their lens shading there: a
//! GainMap with a gain per color, or FixVignetteRadial (opcode 3), a
//! polynomial in the distance from the optical center. PixelGains applies
//! both, a pixel at a time, between the highlight blend and the color
//! conversion, where the white balance is already in: a gain per channel
//! commutes with it.

use rayon::prelude::*;

/// One GainMap opcode's parameters and gains, as the DNG specification
/// lays them out (all big-endian).
#[derive(Debug, Clone, PartialEq)]
pub struct GainMap {
    top: u32,
    left: u32,
    bottom: u32,
    right: u32,
    plane: u32,
    planes: u32,
    row_pitch: u32,
    col_pitch: u32,
    points_v: u32,
    points_h: u32,
    spacing_v: f64,
    spacing_h: f64,
    origin_v: f64,
    origin_h: f64,
    map_planes: u32,
    /// points_v rows of points_h columns of map_planes gains.
    gains: Vec<f32>,
}

const GAIN_MAP: u32 = 9;
const FIX_VIGNETTE_RADIAL: u32 = 3;

/// FixVignetteRadial: gain 1 + k0 r^2 + k1 r^4 + k2 r^6 + k3 r^8 + k4 r^10
/// on every plane, where r is a pixel's distance from the optical
/// center (cx, cy, fractions of the image's width and height) over the
/// distance from that center to the farthest corner.
#[derive(Debug, Clone, PartialEq)]
pub struct Vignette {
    k: [f64; 5],
    cx: f64,
    cy: f64,
}

/// An opcode applied after demosaic.
#[derive(Debug, Clone, PartialEq)]
pub enum Stage3 {
    Gain(GainMap),
    Vignette(Vignette),
}

/// Every opcode in a list, as (id, parameters). A list that ends early or
/// declares more than it holds yields the opcodes read before the fault:
/// a damaged list costs its corrections, never the photograph.
fn opcodes(bytes: &[u8]) -> Vec<(u32, &[u8])> {
    let u32_at = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let mut out = Vec::new();
    let Some(count) = u32_at(0) else { return out };
    let mut at = 4usize;
    for _ in 0..count {
        let (Some(id), Some(len)) = (u32_at(at), u32_at(at + 12)) else { break };
        let start = at + 16;
        let Some(params) = start.checked_add(len as usize).and_then(|end| bytes.get(start..end)) else { break };
        out.push((id, params));
        at = start + len as usize;
    }
    out
}

/// The GainMaps in an opcode list; a map whose sizes do not add up is
/// skipped.
pub fn parse_list(bytes: &[u8]) -> Vec<GainMap> {
    opcodes(bytes).into_iter().filter(|(id, _)| *id == GAIN_MAP).filter_map(|(_, p)| parse_gain_map(p)).collect()
}

/// The GainMaps and FixVignetteRadials in an opcode list, in its order.
pub fn parse_list3(bytes: &[u8]) -> Vec<Stage3> {
    opcodes(bytes)
        .into_iter()
        .filter_map(|(id, p)| match id {
            GAIN_MAP => parse_gain_map(p).map(Stage3::Gain),
            FIX_VIGNETTE_RADIAL => parse_vignette(p).map(Stage3::Vignette),
            _ => None,
        })
        .collect()
}

fn parse_vignette(p: &[u8]) -> Option<Vignette> {
    if p.len() != 56 {
        return None;
    }
    let f: Vec<f64> = p.chunks_exact(8).map(|b| f64::from_be_bytes(b.try_into().unwrap())).collect();
    f.iter().all(|v| v.is_finite()).then(|| Vignette { k: [f[0], f[1], f[2], f[3], f[4]], cx: f[5], cy: f[6] })
}

fn parse_gain_map(p: &[u8]) -> Option<GainMap> {
    let u = |i: usize| p.get(i..i + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let f = |i: usize| p.get(i..i + 8).map(|b| f64::from_be_bytes(b.try_into().unwrap()));
    let (points_v, points_h, map_planes) = (u(32)?, u(36)?, u(72)?);
    let n = (points_v as usize).checked_mul(points_h as usize)?.checked_mul(map_planes as usize)?;
    if n == 0 || p.len() != 76 + n * 4 {
        return None;
    }
    let gains = p[76..].chunks_exact(4).map(|b| f32::from_be_bytes([b[0], b[1], b[2], b[3]])).collect::<Vec<_>>();
    if gains.iter().any(|g| !g.is_finite()) {
        return None;
    }
    let map = GainMap {
        top: u(0)?,
        left: u(4)?,
        bottom: u(8)?,
        right: u(12)?,
        plane: u(16)?,
        planes: u(20)?,
        row_pitch: u(24)?.max(1),
        col_pitch: u(28)?.max(1),
        points_v,
        points_h,
        spacing_v: f(40)?,
        spacing_h: f(48)?,
        origin_v: f(56)?,
        origin_h: f(64)?,
        map_planes,
        gains,
    };
    [map.spacing_v, map.spacing_h, map.origin_v, map.origin_h].iter().all(|v| v.is_finite()).then_some(map)
}

impl GainMap {
    /// Where `pos` (a fraction of the image) falls in a grid of `points`
    /// samples, clamped to the grid: the lower sample and the weight of
    /// the one after it.
    fn locate(pos: f64, origin: f64, spacing: f64, points: u32) -> (usize, f64) {
        let last = points.saturating_sub(1) as f64;
        let x = if spacing > 0.0 { ((pos - origin) / spacing).clamp(0.0, last) } else { 0.0 };
        let i = (x.floor() as usize).min(points.saturating_sub(1) as usize);
        (i, x - i as f64)
    }

    /// The gain at (row, col) of an image `height` by `width`, for the
    /// map's plane `map_plane`: what apply_cfa and apply_rgb compute inline.
    #[cfg(test)]
    fn gain(&self, row: u32, col: u32, height: u32, width: u32, map_plane: u32) -> f32 {
        let (r0, fr) = Self::locate(row as f64 / height.max(1) as f64, self.origin_v, self.spacing_v, self.points_v);
        let (c0, fc) = Self::locate(col as f64 / width.max(1) as f64, self.origin_h, self.spacing_h, self.points_h);
        let r1 = (r0 + 1).min(self.points_v as usize - 1);
        let c1 = (c0 + 1).min(self.points_h as usize - 1);
        let mp = self.map_planes as usize;
        let mpl = (map_plane as usize).min(mp - 1);
        let at = |r: usize, c: usize| self.gains[(r * self.points_h as usize + c) * mp + mpl] as f64;
        let top = at(r0, c0) * (1.0 - fc) + at(r0, c1) * fc;
        let bottom = at(r1, c0) * (1.0 - fc) + at(r1, c1) * fc;
        (top * (1.0 - fr) + bottom * fr) as f32
    }
}

/// A single-plane sensor buffer and the stage 2 image within it.
pub struct Cfa<'a> {
    /// The whole readout, `pitch` samples a row.
    pub data: &'a mut [u16],
    pub pitch: usize,
    /// The active area: its offset in the readout and its size.
    pub top: usize,
    pub left: usize,
    pub height: u32,
    pub width: u32,
}

/// Multiplies every GainMap on plane 0 into a CFA buffer: each covered
/// sample's value above its black level is scaled, and black is added
/// back, rounded and kept within 16 bits. `black(row, col)` is the
/// level the develop will subtract there, in active-area coordinates.
/// The rows go side by side.
pub fn apply_cfa(maps: &[GainMap], img: &mut Cfa, black: impl Fn(u32, u32) -> u32 + Sync) -> usize {
    let mut applied = 0;
    for map in maps.iter().filter(|m| m.plane == 0 && m.planes >= 1) {
        let bottom = map.bottom.min(img.height);
        let right = map.right.min(img.width);
        let mp = map.map_planes as usize;
        let at = |r: usize, c: usize| map.gains[(r * map.points_h as usize + c) * mp] as f64;
        let last_v = map.points_v as usize - 1;
        let last_h = map.points_h as usize - 1;
        // Where each covered column falls in the grid, worked out once:
        // every row reads the same columns.
        let cols: Vec<(u32, usize, f64)> = (map.left..right)
            .step_by(map.col_pitch as usize)
            .map(|col| {
                let (c0, fc) = GainMap::locate(col as f64 / img.width.max(1) as f64, map.origin_h, map.spacing_h, map.points_h);
                (col, c0, fc)
            })
            .collect();
        let (top, left, pitch, height) = (img.top, img.left, img.pitch, img.height);
        img.data.par_chunks_mut(pitch).enumerate().for_each(|(line, data)| {
            let Some(row) = line.checked_sub(top).map(|r| r as u32) else { return };
            if row < map.top || row >= bottom || (row - map.top) % map.row_pitch != 0 {
                return;
            }
            let (r0, fr) = GainMap::locate(row as f64 / height.max(1) as f64, map.origin_v, map.spacing_v, map.points_v);
            let r1 = (r0 + 1).min(last_v);
            for &(col, c0, fc) in &cols {
                let c1 = (c0 + 1).min(last_h);
                let g = ((at(r0, c0) * (1.0 - fc) + at(r0, c1) * fc) * (1.0 - fr) + (at(r1, c0) * (1.0 - fc) + at(r1, c1) * fc) * fr) as f32;
                if let Some(v) = data.get_mut(left + col as usize) {
                    let b = black(row, col) as f32;
                    *v = (b + (*v as f32 - b) * g).round().clamp(0.0, 65535.0) as u16;
                }
            }
        });
        applied += 1;
    }
    applied
}

/// A demosaiced image: `stride` samples a pixel, the first `planes` of
/// them the camera's colors.
pub struct Rgb<'a> {
    pub data: &'a mut [u16],
    pub stride: usize,
    pub planes: usize,
    pub width: u32,
    pub height: u32,
}

impl Vignette {
    /// The gain at (row, col): what apply_rgb computes inline.
    #[cfg(test)]
    fn gain(&self, row: u32, col: u32, height: u32, width: u32) -> f64 {
        let (cx, cy) = (self.cx * width as f64, self.cy * height as f64);
        let far = [(0.0, 0.0), (width as f64, 0.0), (0.0, height as f64), (width as f64, height as f64)]
            .iter()
            .map(|(x, y)| (x - cx).powi(2) + (y - cy).powi(2))
            .fold(0.0, f64::max);
        if far <= 0.0 {
            return 1.0;
        }
        let r2 = ((col as f64 - cx).powi(2) + (row as f64 - cy).powi(2)) / far;
        let [k0, k1, k2, k3, k4] = self.k;
        1.0 + r2 * (k0 + r2 * (k1 + r2 * (k2 + r2 * (k3 + r2 * k4))))
    }
}

/// One stage 3 opcode, worked out for an image's size: where each row and
/// column falls.
#[derive(Clone, Debug)]
enum Prepared {
    /// A GainMap: its planes, and for each row and column it covers, the
    /// grid sample before it and the weight of the one after.
    Gain { map: GainMap, first: usize, last: usize, rows: Vec<Option<(usize, f64)>>, cols: Vec<Option<(usize, f64)>> },
    /// A FixVignetteRadial: each column's squared distance from the
    /// center (over the farthest corner's), and the center's row.
    Vignette { k: [f64; 5], dx2: Vec<f64>, cy: f64, far: f64 },
}

/// OpcodeList3's GainMaps and FixVignetteRadials for an image `width` by
/// `height` with `planes` color planes, applied a pixel at a time.
#[derive(Clone, Debug, Default)]
pub struct PixelGains {
    ops: Vec<Prepared>,
}

impl PixelGains {
    pub fn new(ops: &[Stage3], width: u32, height: u32, planes: usize) -> PixelGains {
        PixelGains::scaled(ops, width, height, planes, 1, (width, height))
    }

    /// For an image each of whose pixels stands for `scale` by `scale` of
    /// the stage 3 image, `full` in size (a half-size develop, scale 2): a
    /// map's area and pitch are in the full image's rows and columns, and
    /// a pixel takes the map where any of the rows and columns it stands
    /// for does. Where the map is in the grid is read from the pixel's
    /// place in its own image, as at scale 1.
    pub fn scaled(ops: &[Stage3], width: u32, height: u32, planes: usize, scale: u32, full: (u32, u32)) -> PixelGains {
        let (w, h) = (width as usize, height as usize);
        let scale = scale.max(1);
        let ops = ops
            .iter()
            .filter_map(|op| match op {
                Stage3::Gain(map) => {
                    let first = map.plane as usize;
                    let last = (first + map.planes as usize).min(planes);
                    if first >= last {
                        return None;
                    }
                    let place = |n: usize, whole: u32, lo: u32, hi: u32, pitch: u32, origin: f64, spacing: f64, points: u32| -> Vec<Option<(usize, f64)>> {
                        let covered = |j: u64| j >= lo as u64 && j < hi.min(whole) as u64 && (j - lo as u64) % pitch as u64 == 0;
                        (0..n as u64)
                            .map(|i| (0..scale as u64).any(|k| covered(i * scale as u64 + k)).then(|| GainMap::locate(i as f64 / n.max(1) as f64, origin, spacing, points)))
                            .collect()
                    };
                    let rows = place(h, full.1, map.top, map.bottom, map.row_pitch, map.origin_v, map.spacing_v, map.points_v);
                    let cols = place(w, full.0, map.left, map.right, map.col_pitch, map.origin_h, map.spacing_h, map.points_h);
                    Some(Prepared::Gain { map: map.clone(), first, last, rows, cols })
                }
                Stage3::Vignette(v) => {
                    let (cx, cy) = (v.cx * w as f64, v.cy * h as f64);
                    let far = [(0.0, 0.0), (w as f64, 0.0), (0.0, h as f64), (w as f64, h as f64)]
                        .iter()
                        .map(|(x, y)| (x - cx).powi(2) + (y - cy).powi(2))
                        .fold(0.0, f64::max);
                    (far > 0.0).then(|| Prepared::Vignette { k: v.k, dx2: (0..w).map(|col| (col as f64 - cx).powi(2) / far).collect(), cy, far })
                }
            })
            .collect();
        PixelGains { ops }
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }

    /// The bytes `PixelGains::new` would hold for the same arguments,
    /// worked out without building its tables: for a develop's admission,
    /// before anything is held.
    pub fn bytes(ops: &[Stage3], width: u32, height: u32, planes: usize) -> usize {
        let (w, h) = (width as usize, height as usize);
        ops.iter()
            .map(|op| match op {
                Stage3::Gain(map) if (map.plane as usize) < (map.plane as usize + map.planes as usize).min(planes) => map.gains.len().saturating_mul(4).saturating_add(w.saturating_add(h).saturating_mul(24)),
                Stage3::Gain(_) => 0,
                Stage3::Vignette(v) => {
                    let (cx, cy) = (v.cx * w as f64, v.cy * h as f64);
                    let far = [(0.0, 0.0), (w as f64, 0.0), (0.0, h as f64), (w as f64, h as f64)].iter().map(|(x, y)| (x - cx).powi(2) + (y - cy).powi(2)).fold(0.0, f64::max);
                    if far > 0.0 { w.saturating_mul(8) } else { 0 }
                }
            })
            .fold(0usize, usize::saturating_add)
    }

    /// Scales pixel (row, col)'s color planes by each opcode's gain in
    /// turn, each rounded and kept within 16 bits.
    #[inline]
    pub fn apply(&self, row: usize, col: usize, px: &mut [u16]) {
        let scale = |v: &mut u16, g: f64| *v = (*v as f64 * g).round().clamp(0.0, 65535.0) as u16;
        for op in &self.ops {
            match op {
                Prepared::Gain { map, first, last, rows, cols } => {
                    let (Some(Some((r0, fr))), Some(Some((c0, fc)))) = (rows.get(row), cols.get(col)) else { continue };
                    let (r0, fr, c0, fc) = (*r0, *fr, *c0, *fc);
                    let mp = map.map_planes as usize;
                    let at = |r: usize, c: usize, p: usize| map.gains[(r * map.points_h as usize + c) * mp + p.min(mp - 1)] as f64;
                    let r1 = (r0 + 1).min(map.points_v as usize - 1);
                    let c1 = (c0 + 1).min(map.points_h as usize - 1);
                    for plane in *first..(*last).min(px.len()) {
                        let p = plane - first;
                        let g = (at(r0, c0, p) * (1.0 - fc) + at(r0, c1, p) * fc) * (1.0 - fr) + (at(r1, c0, p) * (1.0 - fc) + at(r1, c1, p) * fc) * fr;
                        scale(&mut px[plane], g);
                    }
                }
                Prepared::Vignette { k, dx2, cy, far } => {
                    let Some(dx) = dx2.get(col) else { continue };
                    let dy2 = (row as f64 - cy).powi(2) / far;
                    let r2 = dx + dy2;
                    let [k0, k1, k2, k3, k4] = *k;
                    let g = 1.0 + r2 * (k0 + r2 * (k1 + r2 * (k2 + r2 * (k3 + r2 * k4))));
                    for s in px.iter_mut() {
                        scale(s, g);
                    }
                }
            }
        }
    }
}

/// Applies OpcodeList3's GainMaps and FixVignetteRadials, in order, to a
/// demosaiced image whose black is already taken off: each sample is
/// scaled by its gain, rounded and kept within 16 bits. A GainMap reaches
/// the planes it names (its map plane per image plane, the last one for
/// any beyond) and the pixels its area and pitch name; a vignette reaches
/// every pixel and plane. Returns how many opcodes were applied.
pub fn apply_rgb(ops: &[Stage3], img: &mut Rgb) -> usize {
    let planes = img.planes.min(img.stride);
    let gains = PixelGains::new(ops, img.width, img.height, planes);
    let w = img.width as usize;
    let stride = img.stride;
    img.data.par_chunks_mut(w.max(1) * stride).enumerate().for_each(|(row, line)| {
        for (col, px) in line.chunks_exact_mut(stride).enumerate() {
            gains.apply(row, col, &mut px[..planes]);
        }
    });
    gains.ops.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One GainMap opcode's bytes: an area, a plane, pitches, a grid of
    /// gains over the whole image (origin 0, spacing so the last sample
    /// lands on the far edge), flags 0 (required).
    pub fn gain_map_opcode(area: [u32; 4], pitch: [u32; 2], points: [u32; 2], gains: &[f32]) -> Vec<u8> {
        let mut p = Vec::new();
        for v in [area[0], area[1], area[2], area[3], 0, 1, pitch[0], pitch[1], points[0], points[1]] {
            p.extend_from_slice(&v.to_be_bytes());
        }
        let spacing = |n: u32| if n > 1 { 1.0 / (n - 1) as f64 } else { 1.0 };
        for v in [spacing(points[0]), spacing(points[1]), 0.0, 0.0] {
            p.extend_from_slice(&v.to_be_bytes());
        }
        p.extend_from_slice(&1u32.to_be_bytes());
        for g in gains {
            p.extend_from_slice(&g.to_be_bytes());
        }
        let mut op = Vec::new();
        for v in [GAIN_MAP, 0x0103_0000, 0, p.len() as u32] {
            op.extend_from_slice(&v.to_be_bytes());
        }
        op.extend_from_slice(&p);
        op
    }

    fn list(ops: &[Vec<u8>]) -> Vec<u8> {
        let mut l = (ops.len() as u32).to_be_bytes().to_vec();
        for op in ops {
            l.extend_from_slice(op);
        }
        l
    }

    #[test]
    fn a_list_yields_its_gain_maps_and_skips_other_opcodes() {
        let mut other = Vec::new();
        for v in [8u32, 0x0103_0000, 1, 4, 0xdead_beef] {
            other.extend_from_slice(&v.to_be_bytes());
        }
        let map = gain_map_opcode([0, 0, 4, 6], [2, 2], [2, 3], &[1.0, 1.5, 2.0, 1.0, 1.5, 2.0]);
        let maps = parse_list(&list(&[other, map]));
        assert_eq!(maps.len(), 1);
        assert_eq!((maps[0].points_v, maps[0].points_h, maps[0].row_pitch), (2, 3, 2));
    }

    #[test]
    fn a_damaged_list_keeps_what_it_read_and_never_panics() {
        let good = gain_map_opcode([0, 0, 4, 4], [1, 1], [1, 1], &[2.0]);
        let mut short = list(&[good.clone(), good.clone()]);
        short.truncate(short.len() - 3);
        assert_eq!(parse_list(&short).len(), 1, "the first map survives a cut second one");
        // A map that claims more gains than it carries is skipped.
        let mut lying = good.clone();
        lying[16 + 32..16 + 36].copy_from_slice(&5u32.to_be_bytes());
        assert!(parse_list(&list(&[lying])).is_empty());
        for n in 0..good.len() {
            let _ = parse_list(&good[..n]);
        }
        assert!(parse_list(&[]).is_empty());
        assert!(parse_list(&[0xff; 64]).is_empty());
    }

    #[test]
    fn the_gain_is_read_bilinearly_and_clamped_to_the_grid() {
        // Gains 1 at the left edge, 3 at the right, over a 2 by 2 grid.
        let map = &parse_list(&list(&[gain_map_opcode([0, 0, 10, 101], [1, 1], [2, 2], &[1.0, 3.0, 1.0, 3.0])]))[0];
        assert_eq!(map.gain(0, 0, 10, 101, 0), 1.0);
        assert!((map.gain(5, 50, 10, 101, 0) - 2.0).abs() < 0.03, "halfway across: {}", map.gain(5, 50, 10, 101, 0));
        assert!((map.gain(9, 100, 10, 101, 0) - 3.0).abs() < 0.03);
        // A one-sample map is that gain everywhere.
        let flat = &parse_list(&list(&[gain_map_opcode([0, 0, 10, 10], [1, 1], [1, 1], &[1.7])]))[0];
        assert_eq!(flat.gain(9, 9, 10, 10, 0), 1.7);
    }

    #[test]
    fn a_gain_scales_the_value_above_black_on_the_sites_its_pitch_names() {
        // A 4 by 4 active area inside a 6 by 5 readout (top 1, left 2),
        // every sample 1064 over a black of 64; gain 2 on the even rows
        // and columns only (one CFA color).
        let mut data = vec![1064u16; 6 * 5];
        let maps = parse_list(&list(&[gain_map_opcode([0, 0, 4, 4], [2, 2], [1, 1], &[2.0])]));
        let mut img = Cfa { data: &mut data, pitch: 6, top: 1, left: 2, height: 4, width: 4 };
        assert_eq!(apply_cfa(&maps, &mut img, |_, _| 64), 1);
        for r in 0..5 {
            for c in 0..6 {
                let inside = (1..5).contains(&r) && (2..6).contains(&c);
                let site = inside && (r - 1) % 2 == 0 && (c - 2) % 2 == 0;
                assert_eq!(data[r * 6 + c], if site { 2064 } else { 1064 }, "row {r} col {c}");
            }
        }
    }

    #[test]
    fn gains_keep_noise_below_black_and_clip_at_sixteen_bits() {
        let mut data = vec![40u16, 60000];
        let maps = parse_list(&list(&[gain_map_opcode([0, 0, 1, 2], [1, 1], [1, 1], &[2.0])]));
        apply_cfa(&maps, &mut Cfa { data: &mut data, pitch: 2, top: 0, left: 0, height: 1, width: 2 }, |_, _| 64);
        // 40 is 24 under black: twice that under black is 16.
        assert_eq!(data, vec![16, 65535]);
    }

    #[test]
    fn a_map_on_another_plane_is_left_alone() {
        let mut op = gain_map_opcode([0, 0, 2, 2], [1, 1], [1, 1], &[2.0]);
        op[16 + 16..16 + 20].copy_from_slice(&1u32.to_be_bytes());
        let mut data = vec![100u16; 4];
        let maps = parse_list(&list(&[op]));
        assert_eq!(apply_cfa(&maps, &mut Cfa { data: &mut data, pitch: 2, top: 0, left: 0, height: 2, width: 2 }, |_, _| 0), 0);
        assert_eq!(data, vec![100; 4]);
    }

    fn vignette_opcode(k: [f64; 5], cx: f64, cy: f64) -> Vec<u8> {
        let mut p = Vec::new();
        for v in [k[0], k[1], k[2], k[3], k[4], cx, cy] {
            p.extend_from_slice(&v.to_be_bytes());
        }
        let mut op = Vec::new();
        for v in [FIX_VIGNETTE_RADIAL, 0x0103_0000, 0, p.len() as u32] {
            op.extend_from_slice(&v.to_be_bytes());
        }
        op.extend_from_slice(&p);
        op
    }

    #[test]
    fn list3_reads_gain_maps_and_vignettes_in_order() {
        let ops = parse_list3(&list(&[
            vignette_opcode([1.0, 0.0, 0.0, 0.0, 0.0], 0.5, 0.5),
            gain_map_opcode([0, 0, 4, 4], [1, 1], [1, 1], &[2.0]),
        ]));
        assert!(matches!(ops.as_slice(), [Stage3::Vignette(_), Stage3::Gain(_)]), "{ops:?}");
        // A vignette of the wrong length is skipped, the rest kept.
        let mut short = vignette_opcode([1.0; 5], 0.5, 0.5);
        short.truncate(short.len() - 8);
        short[12..16].copy_from_slice(&48u32.to_be_bytes());
        assert_eq!(parse_list3(&list(&[short, gain_map_opcode([0, 0, 4, 4], [1, 1], [1, 1], &[2.0])])).len(), 1);
    }

    #[test]
    fn the_vignette_is_one_at_the_center_and_its_full_sum_at_the_farthest_corner() {
        let Stage3::Vignette(v) = &parse_list3(&list(&[vignette_opcode([0.5, 0.25, 0.0, 0.0, 0.125], 0.5, 0.5)]))[0] else { panic!() };
        assert!((v.gain(50, 100, 100, 200) - 1.0).abs() < 1e-12);
        assert!((v.gain(0, 0, 100, 200) - 1.875).abs() < 1e-12, "{}", v.gain(0, 0, 100, 200));
        // Off center, the farthest corner is the one away from it.
        let Stage3::Vignette(off) = &parse_list3(&list(&[vignette_opcode([1.0, 0.0, 0.0, 0.0, 0.0], 0.25, 0.5)]))[0] else { panic!() };
        assert!((off.gain(0, 200, 100, 200) - 2.0).abs() < 1e-12);
        assert!(off.gain(0, 0, 100, 200) < 2.0);
    }

    #[test]
    fn apply_rgb_scales_the_planes_a_gain_map_names_and_every_plane_for_a_vignette() {
        // 3 by 2 pixels, four samples each, every sample 1000.
        let mut data = vec![1000u16; 3 * 2 * 4];
        let mut red = gain_map_opcode([0, 0, 2, 3], [1, 1], [1, 1], &[1.5]);
        red[16 + 20..16 + 24].copy_from_slice(&1u32.to_be_bytes()); // planes: 1, plane 0
        let ops = parse_list3(&list(&[red]));
        let mut img = Rgb { data: &mut data, stride: 4, planes: 3, width: 3, height: 2 };
        assert_eq!(apply_rgb(&ops, &mut img), 1);
        for px in data.chunks_exact(4) {
            assert_eq!(px, &[1500, 1000, 1000, 1000]);
        }
        // A vignette with the center at a corner pixel: that pixel keeps its
        // value; every color plane moves, the fourth sample does not.
        let mut data = vec![1000u16; 3 * 2 * 4];
        let ops = parse_list3(&list(&[vignette_opcode([1.0, 0.0, 0.0, 0.0, 0.0], 0.0, 0.0)]));
        apply_rgb(&ops, &mut Rgb { data: &mut data, stride: 4, planes: 3, width: 3, height: 2 });
        assert_eq!(&data[..4], &[1000, 1000, 1000, 1000]);
        let last = &data[data.len() - 4..];
        assert!(last[0] > 1000 && last[0] == last[1] && last[1] == last[2] && last[3] == 1000, "{last:?}");
        // Clipped at 16 bits.
        let mut data = vec![60000u16; 4];
        let ops = parse_list3(&list(&[gain_map_opcode([0, 0, 1, 1], [1, 1], [1, 1], &[2.0])]));
        apply_rgb(&ops, &mut Rgb { data: &mut data, stride: 4, planes: 3, width: 1, height: 1 });
        assert_eq!(data, vec![65535, 60000, 60000, 60000]);
    }

    #[test]
    fn the_admitted_bytes_are_what_the_built_tables_hold() {
        // What PixelGains::new holds, measured from what it built.
        let held = |g: &PixelGains| -> usize {
            g.ops
                .iter()
                .map(|op| match op {
                    Prepared::Gain { map, rows, cols, .. } => map.gains.len() * 4 + (rows.len() + cols.len()) * 24,
                    Prepared::Vignette { dx2, .. } => dx2.len() * 8,
                })
                .sum()
        };
        let mut other_plane = gain_map_opcode([0, 0, 2, 3], [1, 1], [2, 2], &[1.5; 4]);
        other_plane[16 + 16..16 + 20].copy_from_slice(&3u32.to_be_bytes());
        let ops = parse_list3(&list(&[
            vignette_opcode([1.0, 0.0, 0.0, 0.0, 0.0], 0.5, 0.5),
            gain_map_opcode([0, 0, 4, 4], [1, 1], [2, 3], &[2.0; 6]),
            other_plane,
        ]));
        for (w, h, planes) in [(640, 480, 3), (7, 5, 1), (0, 0, 3), (1, 1, 3), (9, 4, 4), (9, 4, 0)] {
            assert_eq!(PixelGains::bytes(&ops, w, h, planes), held(&PixelGains::new(&ops, w, h, planes)), "{w} by {h}, {planes}");
            // A half-size develop's tables are its own size's.
            assert_eq!(PixelGains::bytes(&ops, w, h, planes), held(&PixelGains::scaled(&ops, w, h, planes, 2, (2 * w + 1, 2 * h))), "{w} by {h}, {planes} at half size");
        }
    }

    #[test]
    fn at_half_size_a_map_reaches_the_blocks_its_full_size_rows_and_columns_fall_in() {
        // A 40 by 30 image, a map of gain 2 from row 5 and column 8, and one
        // on every second row from row 1 (pitch 2).
        let offset = parse_list3(&list(&[gain_map_opcode([5, 8, 30, 40], [1, 1], [1, 1], &[2.0])]));
        let half = PixelGains::scaled(&offset, 20, 15, 3, 2, (40, 30));
        let gain = |g: &PixelGains, r, c| {
            let mut px = [1000u16; 3];
            g.apply(r, c, &mut px);
            px[0]
        };
        // Block row 2 holds rows 4 and 5, block column 4 columns 8 and 9.
        assert_eq!((gain(&half, 1, 10), gain(&half, 2, 10)), (1000, 2000));
        assert_eq!((gain(&half, 7, 3), gain(&half, 7, 4)), (1000, 2000));
        let pitched = parse_list3(&list(&[gain_map_opcode([1, 0, 30, 40], [2, 1], [1, 1], &[2.0])]));
        let half = PixelGains::scaled(&pitched, 20, 15, 3, 2, (40, 30));
        assert!((0..15).all(|r| gain(&half, r, 0) == 2000));
        // At full size, scale 1 is new's.
        let full = PixelGains::scaled(&offset, 40, 30, 3, 1, (40, 30));
        assert_eq!((gain(&full, 4, 10), gain(&full, 5, 10), gain(&full, 5, 7)), (1000, 2000, 1000));
    }
}
