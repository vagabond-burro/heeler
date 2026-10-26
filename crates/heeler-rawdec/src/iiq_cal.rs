//! The sensor calibration LibRaw applies to a Phase One IIQ frame after
//! unpacking it (iiq.rs), as found from the files' bytes against LibRaw's
//! loaded image.
//!
//! The container at byte 8 (see iiq.rs) states the black level (tag
//! 0x021D; none on the H 25, whose frames are black 0), the coding (0x010E),
//! the sensor's temperature (0x0210, a 32-bit float), and on backs read in
//! halves or quarters the column the right half starts at (0x0222), the row
//! the bottom half starts at (0x0224), each row's black offset for the left
//! and right half (0x0223) and each column's for the top and bottom half
//! (0x0225), two signed 16-bit values a row or column. Tag 0x0110 points at
//! a calibration block: "IIII", a 32-bit 1, the offset of its directory
//! (from the block's start), the directory a 32-bit count, 4 bytes, then
//! 12-byte entries (tag, length, offset from the block's start), a tag
//! given more than once where the sensor is calibrated in tiles. The
//! entries used:
//!
//! - 0x0400, the defects: 8 bytes each, column, row, kind and a fourth value
//!   (16-bit, frame coordinates). Kind 129 is one pixel, 131 and 137 a
//!   whole column; others (138, a few on the IQ180 and P65+) are left.
//! - 0x0416, 0x0410, 0x0401 and 0x040B, gain grids: a header of 16-bit
//!   left, top, width, height, horizontal and vertical spacing (frame
//!   coordinates), then the gains a row of nodes at a time, one node every
//!   spacing from the top left (width / spacing nodes across, rounded up,
//!   and likewise down). 0x0416 and 0x0410 hold a 16-bit gain a node, 32768
//!   being 1, for every pixel; 0x0401 (the H 25) a 32-bit float, 1 being 1;
//!   0x040B two 16-bit gains, the first for red pixels, the second for
//!   blue. Newer backs give each quarter, eighth or seam strip of the sensor
//!   its own grid of a tag (a strip being spacing 1).
//! - 0x041A, four 32-bit floats: a cubic, its constant term 0, that
//!   corrects the response of the whole sensor.
//! - 0x0419, "II", a 16-bit 1, then eight 32-bit floats: per half (left,
//!   right) the constant, linear and square terms of a correction of the
//!   response, then a temperature coefficient and the temperature it is
//!   relative to. Only the right half's terms are found to be applied.
//! - 0x0431, each quarter's gain by level: 32-bit words, n levels, then for
//!   each quarter (top left, top right, bottom left, bottom right) its n
//!   gains at them, 10000 being 1, then a 1.
//!
//! The rules, each matched pixel for pixel against LibRaw's output (every
//! product and sum in 32-bit floats, in the order written, each step's
//! result rounded down to an integer, unless said):
//!
//! 1. Black: each sample less the black level plus its row's offset for its
//!    half and its column's offset for its half. LibRaw applies neither
//!    offset to frames of coding 6 (the IIQ S files of the backs with
//!    them).
//! 2. Quarters: where 0x0431 is given, the value goes through its quarter's
//!    curve (where 0x041F is given, the P40+ and P65+, its quarter's curve
//!    by iiq_quarters.rs's rules): the natural cubic spline through (0, 0), each level paired with
//!    the level times its gain (rounded down), and (65535, 65535), rounded
//!    half up. (LibRaw's arithmetic for the spline is not the double
//!    precision used here: about one value in 5000 on the curve, there
//!    within a thousandth of a half, comes out one off.)
//! 3. Right half: a value x right of the split becomes x (m + x c), where m
//!    is 1 + k (t - t0) (k the temperature coefficient, t the sensor's
//!    temperature, t0 the reference) plus b, and b and c are the right
//!    half's linear and square terms (summed in that order: the last bit
//!    of m shows in the results).
//! 4. Response: x becomes x + x (c1 + x (c2 + x c3)), the cubic of 0x041A.
//! 5. Defects, in the order listed, each from the values the steps above
//!    give (and from defects already replaced): a pixel becomes the mean of
//!    eight same-colored neighbors, rounded half up: for a green pixel on a
//!    row with red, the four diagonal ones and the four two away across and
//!    down; else the eight two away across, down and diagonally. A pixel
//!    within two of the frame's edge is left. A defective column becomes
//!    the mean of the columns two to each side, rounded half up: LibRaw's
//!    rule for columns is not this, and is not found (its values differ
//!    from this mean by about the image's own noise, and not by anything a
//!    linear mix of the 5 by 9 same-colored neighbors explains), so these
//!    pixels are close, not exact.
//! 6. Gains: the value times each grid's gain in the block's order (0x0416,
//!    then 0x0410 or 0x0401, then 0x040B, a red pixel times its first
//!    gain and a blue one its second). A grid's gain at a pixel: down a
//!    column of nodes, the two rows of nodes about the pixel's row mixed in
//!    proportion; then along the row, from the node at or left of the
//!    pixel, a step of a spacing-th of the way to the next node added once
//!    for each column past it (LibRaw steps, it does not multiply, and the
//!    32-bit sums carry their rounding). A grid applies from its top left
//!    up to, not including, its last row and column of nodes (and to no
//!    more than its width and height less a spacing); where tiles of one
//!    tag overlap, a pixel is the tile's whose left or top is the later.
//!    The value is held to 0 to 65535 before the grids and after each.
//! 7. The result is held to 0 to 65535.
//!
//! The result over LibRaw's area is LibRaw's loaded image with its black
//! level 0: nothing further is to be subtracted. LibRaw's area is the
//! file's (0x010A to 0x010D) with an odd top or left moved one on and the
//! size one less (so a P25+ is 4096 by 5455 at top 22, left 26; a P45+ 7245
//! by 5444 at top 22, left 42; an IQ4 150MP 14204 by 10652 at top 106, left
//! 102).
//!
//! The P40+ and P65+ (tags 0x041E and 0x041F) take each quarter's curve
//! by iiq_quarters.rs's rules in step 2's place, found closely but not to
//! the bit.

use rayon::prelude::*;

/// One entry of the defect list.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Defect {
    /// A pixel, at frame column and row.
    Pixel(usize, usize),
    /// A whole frame column.
    Column(usize),
}

/// A grid of gains, 32768 being 1.
#[derive(Clone, Debug, PartialEq)]
pub struct Grid {
    pub left: i64,
    pub top: i64,
    /// The pixels it applies to, from left and top.
    pub width: usize,
    pub height: usize,
    pub step_x: usize,
    pub step_y: usize,
    pub nodes_x: usize,
    pub nodes_y: usize,
    /// Gains a node (1, or 2 for red and blue).
    pub planes: usize,
    /// Row by row, a node's planes together, 32768 being 1.
    pub gains: Vec<f32>,
    /// The block's tag it came from.
    pub tag: u32,
}

/// What LibRaw corrects an IIQ frame by.
#[derive(Clone, Debug, PartialEq)]
pub struct Calibration {
    pub black: i32,
    /// The frame column the right half starts at, on backs read in two.
    pub split: Option<usize>,
    /// Each frame row's black offset, left and right half.
    pub row_black: Vec<[i32; 2]>,
    /// The right half's response: 1 plus the temperature's share plus its
    /// linear term, and its square term.
    pub right: Option<(f32, f32)>,
    /// The whole sensor's response cubic, its linear, square and cube terms.
    pub response: Option<[f32; 3]>,
    pub defects: Vec<Defect>,
    /// In the block's order, each applied in turn.
    pub grids: Vec<Grid>,
    /// The frame row the bottom half starts at, on backs read in quarters.
    pub split_row: Option<usize>,
    /// Each frame column's black offset, top and bottom half.
    pub col_black: Vec<[i32; 2]>,
    /// Each quarter's response curve (top left, top right, bottom left,
    /// bottom right), as a table from CURVE_FROM up.
    pub curves: Option<[Vec<i32>; 4]>,
}

/// The first value the quarter curves' tables hold (they run to
/// 65535 + 8192; values past either end take the end's).
const CURVE_FROM: i32 = -8192;

/// A natural cubic spline through `pts` (in increasing x), as a table of
/// its values rounded half up for x from CURVE_FROM to 65535 + 8192.
fn spline_table(pts: &[(f64, f64)]) -> Vec<i32> {
    let n = pts.len();
    let h: Vec<f64> = (0..n - 1).map(|i| pts[i + 1].0 - pts[i].0).collect();
    // Second derivatives, natural ends: the tridiagonal system solved.
    let mut m = vec![0f64; n];
    if n > 2 {
        let (mut diag, mut rhs) = (vec![0f64; n], vec![0f64; n]);
        for i in 1..n - 1 {
            diag[i] = 2.0 * (h[i - 1] + h[i]);
            rhs[i] = 6.0 * ((pts[i + 1].1 - pts[i].1) / h[i] - (pts[i].1 - pts[i - 1].1) / h[i - 1]);
        }
        for i in 2..n - 1 {
            let w = h[i - 1] / diag[i - 1];
            diag[i] -= w * h[i - 1];
            rhs[i] -= w * rhs[i - 1];
        }
        for i in (1..n - 1).rev() {
            m[i] = (rhs[i] - if i + 1 < n - 1 { h[i] * m[i + 1] } else { 0.0 }) / diag[i];
        }
    }
    let eval = |x: f64| {
        let i = match pts.iter().rposition(|p| p.0 <= x) {
            Some(i) => i.min(n - 2),
            None => 0,
        };
        let (x0, y0, x1, y1, hh) = (pts[i].0, pts[i].1, pts[i + 1].0, pts[i + 1].1, h[i]);
        if x < x0 || x > x1 {
            // Past the ends: the end's tangent.
            let slope = (y1 - y0) / hh + if x < x0 { -hh * (2.0 * m[i] + m[i + 1]) / 6.0 } else { hh * (m[i] + 2.0 * m[i + 1]) / 6.0 };
            return if x < x0 { y0 + slope * (x - x0) } else { y1 + slope * (x - x1) };
        }
        let (a, b) = ((x1 - x) / hh, (x - x0) / hh);
        a * y0 + b * y1 + ((a * a * a - a) * m[i] + (b * b * b - b) * m[i + 1]) * hh * hh / 6.0
    };
    (CURVE_FROM..65536 + 8192).map(|x| (eval(x as f64) + 0.5).floor() as i32).collect()
}

fn u16le(b: &[u8], at: usize) -> Option<u16> {
    b.get(at..at + 2).map(|v| u16::from_le_bytes([v[0], v[1]]))
}

fn u32le(b: &[u8], at: usize) -> Option<u32> {
    b.get(at..at + 4).map(|v| u32::from_le_bytes([v[0], v[1], v[2], v[3]]))
}

fn f32le(b: &[u8], at: usize) -> Option<f32> {
    u32le(b, at).map(f32::from_bits)
}

/// The container's entries: tag, then type, count and value.
fn container(bytes: &[u8]) -> Option<Vec<(u32, u32, u32, u32)>> {
    if bytes.get(8..12)? != b"IIII" {
        return None;
    }
    let at = 8 + u32le(bytes, 16)? as usize;
    let n = u32le(bytes, at)? as usize;
    if n > 4096 {
        return None;
    }
    (0..n).map(|i| Some((u32le(bytes, at + 8 + 16 * i)?, u32le(bytes, at + 12 + 16 * i)?, u32le(bytes, at + 16 + 16 * i)?, u32le(bytes, at + 20 + 16 * i)?))).collect()
}

fn grid(block: &[u8], at: usize, len: usize, planes: usize, float: bool) -> Option<Grid> {
    let h = |k: usize| u16le(block, at + 2 * k).map(|v| v as usize);
    let (left, top, width, height, step_x, step_y) = (h(0)?, h(1)?, h(2)?, h(3)?, h(4)?, h(5)?);
    if step_x == 0 || step_y == 0 {
        return None;
    }
    let (nodes_x, nodes_y) = (width.div_ceil(step_x), height.div_ceil(step_y));
    let n = nodes_x * nodes_y * planes;
    if nodes_x < 2 || nodes_y < 2 || 16 + if float { 4 } else { 2 } * n > len {
        return None;
    }
    let gains = match float {
        false => (0..n).map(|i| u16le(block, at + 16 + 2 * i).map(|v| v as f32)).collect::<Option<Vec<_>>>()?,
        true => (0..n).map(|i| f32le(block, at + 16 + 4 * i).map(|v| v * 32768.0)).collect::<Option<Vec<_>>>()?,
    };
    // It applies up to its last node, not to it, and short of its stated
    // size by a spacing (the half-size P65+ files' last columns).
    let (width, height) = (width.min((nodes_x - 1) * step_x).min(width.saturating_sub(step_x)), height.min((nodes_y - 1) * step_y).min(height.saturating_sub(step_y)));
    Some(Grid { left: left as i64, top: top as i64, width, height, step_x, step_y, nodes_x, nodes_y, planes, gains, tag: 0 })
}

/// The calibration of an IIQ, given the whole file; None where the file
/// has none or one of the kind not read here.
pub fn read(bytes: &[u8]) -> Option<Calibration> {
    let dir = container(bytes)?;
    let get = |tag: u32| dir.iter().find(|e| e.0 == tag).map(|e| (e.1, e.2, e.3));
    let value = |tag: u32| get(tag).map(|e| e.2);
    let height = value(0x0109)? as usize;
    let black = value(0x021d).unwrap_or(0) as i32;
    let split = value(0x0222).map(|v| v as usize);
    // The offsets are not applied to frames of coding 6.
    let coded_6 = value(0x010e) == Some(6);
    let mut row_black = vec![[0i32; 2]; height];
    if let (Some((_, count, at)), false) = (get(0x0223), coded_6) {
        let at = 8 + at as usize;
        for (r, rb) in row_black.iter_mut().enumerate().take((count as usize / 4).min(height)) {
            for (k, v) in rb.iter_mut().enumerate() {
                *v = u16le(bytes, at + 4 * r + 2 * k)? as i16 as i32;
            }
        }
    }
    let split_row = value(0x0224).map(|v| v as usize);
    let width = value(0x0108)? as usize;
    let mut col_black = vec![[0i32; 2]; width];
    if let (Some((_, count, at)), false) = (get(0x0225), coded_6) {
        let at = 8 + at as usize;
        for (c, cb) in col_black.iter_mut().enumerate().take((count as usize / 4).min(width)) {
            for (k, v) in cb.iter_mut().enumerate() {
                *v = u16le(bytes, at + 4 * c + 2 * k)? as i16 as i32;
            }
        }
    }
    let (_, len, at) = get(0x0110)?;
    let start = 8 + at as usize;
    let block = bytes.get(start..start + len as usize)?;
    if block.get(0..4)? != b"IIII" {
        return None;
    }
    let d = u32le(block, 8)? as usize;
    let n = u32le(block, d)? as usize;
    if n > 4096 {
        return None;
    }
    let entries: Vec<(u32, usize, usize)> = (0..n).map(|i| Some((u32le(block, d + 8 + 12 * i)?, u32le(block, d + 12 + 12 * i)? as usize, u32le(block, d + 16 + 12 * i)? as usize))).collect::<Option<_>>()?;
    let entry = |tag: u32| entries.iter().find(|e| e.0 == tag).map(|e| (e.2, e.1));
    // The quarter curves of the P40+ and P65+ (0x041F to 0x0428, with
    // 0x041E's gains): not found, so not read.
    if entry(0x0429).is_some() && entry(0x0431).is_none() {
        return None;
    }
    let mut defects = Vec::new();
    if let Some((at, len)) = entry(0x0400) {
        for i in 0..len / 8 {
            let (x, y, kind) = (u16le(block, at + 8 * i)? as usize, u16le(block, at + 8 * i + 2)? as usize, u16le(block, at + 8 * i + 4)?);
            match kind {
                129 => defects.push(Defect::Pixel(x, y)),
                131 | 137 => defects.push(Defect::Column(x)),
                _ => {}
            }
        }
    }
    let mut grids = Vec::new();
    for &(tag, len, at) in &entries {
        let (planes, float) = match tag {
            0x0416 | 0x0410 => (1, false),
            0x0401 => (1, true),
            0x040b => (2, false),
            _ => continue,
        };
        let mut g = grid(block, at, len, planes, float)?;
        g.tag = tag;
        grids.push(g);
    }
    // Tiles of one grid share their edge nodes; a pixel there is the next
    // tile's.
    let snapshot = grids.clone();
    for g in &mut grids {
        for o in &snapshot {
            if o.tag != g.tag || o.step_x != g.step_x {
                continue;
            }
            if o.left > g.left && o.top == g.top && o.left < g.left + g.width as i64 {
                g.width = (o.left - g.left) as usize;
            }
            if o.top > g.top && o.left == g.left && o.top < g.top + g.height as i64 {
                g.height = (o.top - g.top) as usize;
            }
        }
    }
    let response = entry(0x041a).and_then(|(at, _)| Some([f32le(block, at + 4)?, f32le(block, at + 8)?, f32le(block, at + 12)?]));
    let right = match (entry(0x0419), split) {
        (Some((at, _)), Some(_)) => {
            let f = |k: usize| f32le(block, at + 4 + 4 * k);
            let t = f32::from_bits(value(0x0210)?);
            Some(((1.0f32 + f(6)? * (t - f(7)?)) + f(3)?, f(5)?))
        }
        _ => None,
    };
    // The quarters' gain by level (0x0431: levels, then each quarter's
    // gains at them, 10000 being 1).
    let curves = match (entry(0x0431), entry(0x041f)) {
        // The P40+ and P65+ quarter curves (iiq_quarters.rs).
        (None, Some(_)) => Some(crate::iiq_quarters::read(block, &entries, CURVE_FROM, 65536 + 8192)?),
        (Some(_), Some(_)) => return None,
        (Some((at, len)), None) => {
            let words: Vec<u32> = (0..len / 4).map(|i| u32le(block, at + 4 * i)).collect::<Option<_>>()?;
            let n = (words.len().saturating_sub(1)) / 5;
            if n < 2 {
                return None;
            }
            let curve = |q: usize| {
                let mut pts = vec![(0.0, 0.0)];
                for i in 0..n {
                    let l = words[i] as f64;
                    pts.push((l, (l * words[n + q * n + i] as f64 / 10000.0).floor()));
                }
                pts.push((65535.0, 65535.0));
                spline_table(&pts)
            };
            Some([curve(0), curve(1), curve(2), curve(3)])
        }
        (None, None) => None,
    };
    Some(Calibration { black, split, row_black, right, response, defects, grids, split_row, col_black, curves })
}

impl Calibration {
    /// Steps 1 to 4 for the sample `a` at frame column `x`, row `y`.
    pub fn value(&self, a: u16, x: usize, y: usize) -> i32 {
        let right = self.split.is_some_and(|s| x >= s);
        let bottom = self.split_row.is_some_and(|s| y >= s);
        let mut v = a as i32 - self.black + self.row_black.get(y).map_or(0, |r| r[right as usize]) + self.col_black.get(x).map_or(0, |c| c[bottom as usize]);
        if let Some(curves) = &self.curves {
            let t = &curves[bottom as usize * 2 + right as usize];
            v = t[((v - CURVE_FROM).max(0) as usize).min(t.len() - 1)];
        }
        if let (true, Some((b, c))) = (right, self.right) {
            let f = v as f32;
            v = (f * (b + f * c)).floor() as i32;
        }
        if let Some([c1, c2, c3]) = self.response {
            let f = v as f32;
            v = (f + f * (c1 + f * (c2 + f * c3))).floor() as i32;
        }
        v
    }
}

/// A grid's gains along frame row `y` for columns `x0..x0 + out.len()`, of
/// plane `plane`, as LibRaw steps them.
fn grid_row(g: &Grid, plane: usize, y: usize, x0: usize, out: &mut [f32]) {
    let node = |j: usize, i: usize| g.gains[(j * g.nodes_x + i) * g.planes + plane];
    let dy = y as i64 - g.top;
    let iy = dy.div_euclid(g.step_y as i64).clamp(0, g.nodes_y as i64 - 2) as usize;
    let ay = ((dy - (iy * g.step_y) as i64) as f64 / g.step_y as f64) as f32;
    let col = |i: usize| node(iy, i) * (1.0 - ay) + node(iy + 1, i) * ay;
    let span = (g.nodes_x - 1) * g.step_x;
    let mut cell = usize::MAX;
    let (mut acc, mut step, mut k) = (0f32, 0f32, 0usize);
    for (o, gain) in out.iter_mut().enumerate() {
        let c = ((x0 + o) as i64 - g.left).clamp(0, span as i64) as usize;
        let i = (c / g.step_x).min(g.nodes_x - 2);
        let kk = c - i * g.step_x;
        if i != cell || kk < k {
            let (l, r) = (col(i), col(i + 1));
            step = (r - l) / g.step_x as f32;
            acc = l;
            k = 0;
            cell = i;
        }
        while k < kk {
            acc += step;
            k += 1;
        }
        *gain = acc / 32768.0;
    }
}

/// Corrects the `width` by `height` frame (as unpacked, in the frame's
/// units: LibRaw's raw frame) in place: afterwards LibRaw's area of it is
/// LibRaw's loaded image, black level 0. `colors` are the CFA colors (0
/// red, 1 green, 2 blue) at frame (0, 0), (0, 1), (1, 0) and (1, 1). Across
/// the cores but for the defects (a few thousand, in turn).
pub fn apply(cal: &Calibration, frame: &mut [u16], width: usize, height: usize, colors: [u8; 4]) {
    assert!(frame.len() >= width * height);
    let color = |x: usize, y: usize| colors[(y & 1) * 2 + (x & 1)];
    let green_on_red = |x: usize, y: usize| color(x, y) == 1 && colors[(y & 1) * 2 + ((x & 1) ^ 1)] == 0;
    // Step 5: the defects' values, in list order, each from the values of
    // steps 1 to 4 and the defects already replaced.
    let mut fixed: std::collections::HashMap<(usize, usize), i32> = std::collections::HashMap::new();
    {
        let f: &[u16] = frame;
        let at = |fixed: &std::collections::HashMap<(usize, usize), i32>, x: usize, y: usize| fixed.get(&(x, y)).copied().unwrap_or_else(|| cal.value(f[y * width + x], x, y));
        const RING: [(i64, i64); 8] = [(-2, -2), (-2, 0), (-2, 2), (0, -2), (0, 2), (2, -2), (2, 0), (2, 2)];
        const GREEN: [(i64, i64); 8] = [(-1, -1), (-1, 1), (1, -1), (1, 1), (-2, 0), (0, -2), (0, 2), (2, 0)];
        for d in &cal.defects {
            match *d {
                Defect::Pixel(x, y) => {
                    if x < 2 || y < 2 || x + 2 >= width || y + 2 >= height {
                        continue;
                    }
                    let ring = if green_on_red(x, y) { &GREEN } else { &RING };
                    let s: i32 = ring.iter().map(|&(dy, dx)| at(&fixed, (x as i64 + dx) as usize, (y as i64 + dy) as usize)).sum();
                    fixed.insert((x, y), (s + 4).div_euclid(8));
                }
                Defect::Column(x) => {
                    if x < 2 || x + 2 >= width {
                        continue;
                    }
                    for y in 0..height {
                        let s = at(&fixed, x - 2, y) + at(&fixed, x + 2, y);
                        fixed.insert((x, y), (s + 1).div_euclid(2));
                    }
                }
            }
        }
    }
    // Steps 1 to 4, 6 and 7, a row at a time.
    let mut by_row: Vec<Vec<(usize, i32)>> = vec![Vec::new(); height];
    for (&(x, y), &v) in &fixed {
        by_row[y].push((x, v));
    }
    frame[..width * height].par_chunks_mut(width).zip(by_row.par_iter()).enumerate().for_each(|(y, (row, fixes))| {
        let mut v: Vec<i32> = row.iter().enumerate().map(|(x, &a)| cal.value(a, x, y)).collect();
        for &(x, val) in fixes {
            v[x] = val;
        }
        gains(cal, y, colors, &mut v);
        for (o, val) in row.iter_mut().zip(&v) {
            *o = (*val).clamp(0, 65535) as u16;
        }
    });
}

/// Step 6 on frame row `y`: `v` (the whole row) times each grid's gains.
/// `colors` as for `apply`.
pub fn gains(cal: &Calibration, y: usize, colors: [u8; 4], v: &mut [i32]) {
    let width = v.len();
    let mut gain = vec![0f32; width];
    // Held to 0 to 65535 before the grids and after each.
    v.iter_mut().for_each(|x| *x = (*x).clamp(0, 65535));
    for g in &cal.grids {
        if (y as i64) < g.top || y as i64 >= g.top + g.height as i64 {
            continue;
        }
        let x0 = g.left.max(0) as usize;
        let x1 = ((g.left + g.width as i64).max(0) as usize).min(width);
        if x0 >= x1 {
            continue;
        }
        for plane in 0..g.planes {
            grid_row(g, plane, y, x0, &mut gain[x0..x1]);
            let want = if plane == 0 { 0 } else { 2 };
            for (x, val) in v.iter_mut().enumerate().take(x1).skip(x0) {
                if g.planes == 1 || colors[(y & 1) * 2 + (x & 1)] == want {
                    *val = (*val as f32 * gain[x]).floor() as i32;
                }
            }
        }
        v[x0..x1].iter_mut().for_each(|x| *x = (*x).clamp(0, 65535));
    }
}
