//! Adaptive homogeneity-directed demosaicing (K. Hirakawa and T. W.
//! Parks, IEEE Transactions on Image Processing 14(3), 2005), the
//! default demosaic of a Bayer develop.
//!
//! Each pixel's missing colors are interpolated twice, once along the
//! row and once along the column: green from its two neighbors in that
//! direction with a second-order correction from the pixel's own color,
//! limited to the neighbors' range; red and blue from the neighboring
//! color differences against that direction's green. Both candidates go
//! to CIELab, and each direction scores how many of a pixel's four
//! neighbors lie within an adaptive distance of it (the paper's
//! homogeneity, with the distance taken from the smaller of the two
//! directions' larger neighbor differences, in lightness and in
//! chroma). Summed over the 3 by 3 around the pixel, the higher score
//! picks the direction; a tie takes the mean of both.
//!
//! The frame is worked in independent tiles across the cores, each with
//! its own buffers. A pixel within BORDER of the frame's edge has no
//! room for the filters; it takes the mean of its 3 by 3 neighbors of
//! each missing color instead.

use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;

use crate::Error;

/// Output tile edge; each tile works MARGIN more on every side.
pub const TILE: usize = 128;
const MARGIN: usize = 3;
const SPAN: usize = TILE + 2 * MARGIN;
/// The frame edge AHD leaves to the border interpolation: the filters
/// reach two pixels past the green, which reaches three past the output.
pub const BORDER: usize = 5;

/// What one worker holds while it works a tile, in bytes: two greens,
/// two RGB, two Lab and two homogeneity maps over the tile and margin.
pub const fn worker_bytes() -> usize {
    SPAN * SPAN * (2 * 2 + 2 * 6 + 2 * 6 + 2)
}

/// A Bayer mosaic, its colors 0 red, 1 green, 2 blue repeating every two
/// rows and columns.
pub struct Mosaic<'a> {
    pub data: &'a [u16],
    pub width: usize,
    pub height: usize,
    pub pattern: [[u8; 2]; 2],
}

impl Mosaic<'_> {
    #[inline(always)]
    fn color(&self, r: usize, c: usize) -> usize {
        self.pattern[r & 1][c & 1] as usize
    }
    #[inline(always)]
    fn at(&self, r: usize, c: usize) -> i32 {
        self.data[r * self.width + c] as i32
    }
}

/// CIELab from camera RGB: XYZ through `xyz_cam` (already over the D65
/// white), then the CIE cube root, read from a table over the 16-bit
/// range. L, a and b are scaled by 64 into integers.
pub struct Lab {
    xyz_cam: [[f32; 3]; 3],
    cbrt: Vec<f32>,
}

impl Lab {
    /// `rgb_cam` is the develop's camera-to-sRGB matrix.
    pub fn new(rgb_cam: &[[f32; 3]; 3]) -> Lab {
        let mut xyz_cam = [[0.0f32; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    // Each term in double, the sum in single precision.
                    xyz_cam[i][j] += (crate::color::XYZ_FROM_SRGB[i][k] * rgb_cam[k][j] as f64 / crate::color::D65[i] as f64) as f32;
                }
            }
        }
        // In single precision throughout, which is what makes it LibRaw's
        // table to the bit (found against its develops on the corpus).
        let cbrt = (0..0x10000)
            .map(|i| {
                let r = i as f32 / 65535.0;
                if r > 0.008856 { r.powf(1.0 / 3.0) } else { crate::fmadd(7.787, r, 16.0 / 116.0) }
            })
            .collect();
        Lab { xyz_cam, cbrt }
    }

    /// L alone, as `of` gives it.
    #[inline(always)]
    pub(crate) fn lightness(&self, rgb: [u16; 3]) -> i16 {
        let mut y = 0.5f32;
        for c in 0..3 {
            y = crate::fmadd(self.xyz_cam[1][c], rgb[c] as f32, y);
        }
        (64.0 * crate::fmadd(116.0, self.cbrt[(y as i32).clamp(0, 65535) as usize], -16.0)) as i16
    }

    #[inline(always)]
    pub(crate) fn of(&self, rgb: [u16; 3]) -> [i16; 3] {
        // Rounded to the nearest table entry; each product and sum one
        // fused multiply-add, as the arm64 build of LibRaw computes it.
        let mut xyz = [0.5f32; 3];
        for i in 0..3 {
            for c in 0..3 {
                xyz[i] = crate::fmadd(self.xyz_cam[i][c], rgb[c] as f32, xyz[i]);
            }
        }
        let f = xyz.map(|v| self.cbrt[(v as i32).clamp(0, 65535) as usize]);
        [(64.0 * crate::fmadd(116.0, f[1], -16.0)) as i16, (64.0 * 500.0 * (f[0] - f[1])) as i16, (64.0 * 200.0 * (f[1] - f[2])) as i16]
    }
}

/// A raw pointer the tiles share to write disjoint pixels of one image.
#[derive(Clone, Copy)]
pub struct Out(pub *mut u16);
unsafe impl Send for Out {}
unsafe impl Sync for Out {}

/// The same for bytes.
#[derive(Clone, Copy)]
pub struct OutBytes(pub *mut u8);
unsafe impl Send for OutBytes {}
unsafe impl Sync for OutBytes {}

impl OutBytes {
    #[inline(always)]
    pub fn at(self, i: usize) -> *mut u8 {
        // SAFETY: callers index inside the buffer the pointer came from.
        unsafe { self.0.add(i) }
    }
}

impl Out {
    /// The address `i` samples in. Taking `self` whole keeps a closure's
    /// capture of it Send and Sync.
    #[inline(always)]
    pub fn at(self, i: usize) -> *mut u16 {
        // SAFETY: callers index inside the buffer the pointer came from.
        unsafe { self.0.add(i) }
    }
}

/// Demosaics `m`, handing each finished pixel (row, col, camera RGB) to
/// `put`, every pixel once, from many threads at once. Stops with
/// Canceled between tiles once `stop` is set.
pub fn demosaic(m: &Mosaic, lab: &Lab, stop: Option<&AtomicBool>, put: &(impl Fn(usize, usize, [u16; 3]) + Sync)) -> Result<(), Error> {
    if m.width < 2 * BORDER + 1 || m.height < 2 * BORDER + 1 {
        border(m, 0, m.height, put);
        return Ok(());
    }
    let (h, w) = (m.height, m.width);
    // The border rows, and the border columns of the rows between.
    (0..h).into_par_iter().for_each(|r| {
        if r < BORDER || r >= h - BORDER {
            border(m, r, r + 1, put);
        } else {
            border_cols(m, r, put);
        }
    });
    let inner = (BORDER, h - BORDER, BORDER, w - BORDER);
    let tiles: Vec<(usize, usize)> = (inner.0..inner.1).step_by(TILE).flat_map(|y| (inner.2..inner.3).step_by(TILE).map(move |x| (y, x))).collect();
    tiles.par_iter().try_for_each_init(
        || Buffers::new(),
        |b, &(y, x)| {
            if stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
                return Err(Error::Canceled);
            }
            tile(m, lab, b, y, (y + TILE).min(inner.1), x, (x + TILE).min(inner.3), put);
            Ok(())
        },
    )
}

/// The mean of each missing color over the 3 by 3 around each pixel of
/// rows `r0..r1`, its own color kept.
fn border(m: &Mosaic, r0: usize, r1: usize, put: &impl Fn(usize, usize, [u16; 3])) {
    for r in r0..r1 {
        for c in 0..m.width {
            put(r, c, border_pixel(m, r, c));
        }
    }
}

fn border_cols(m: &Mosaic, r: usize, put: &impl Fn(usize, usize, [u16; 3])) {
    for c in (0..BORDER).chain(m.width - BORDER..m.width) {
        put(r, c, border_pixel(m, r, c));
    }
}

#[inline]
fn border_pixel(m: &Mosaic, r: usize, c: usize) -> [u16; 3] {
    let mut sum = [0u32; 3];
    let mut n = [0u32; 3];
    for y in r.saturating_sub(1)..(r + 2).min(m.height) {
        for x in c.saturating_sub(1)..(c + 2).min(m.width) {
            let k = m.color(y, x);
            sum[k] += m.at(y, x) as u32;
            n[k] += 1;
        }
    }
    let own = m.color(r, c);
    let mut px = [0u16; 3];
    for k in 0..3 {
        px[k] = if k == own { m.at(r, c) as u16 } else if n[k] > 0 { (sum[k] / n[k]) as u16 } else { 0 };
    }
    px
}

struct Buffers {
    green: [Vec<u16>; 2],
    rgb: [Vec<[u16; 3]>; 2],
    lab: [Vec<[i16; 3]>; 2],
    homo: [Vec<u8>; 2],
}

impl Buffers {
    fn new() -> Self {
        let n = SPAN * SPAN;
        Buffers {
            green: [vec![0; n], vec![0; n]],
            rgb: [vec![[0; 3]; n], vec![[0; 3]; n]],
            lab: [vec![[0; 3]; n], vec![[0; 3]; n]],
            homo: [vec![0; n], vec![0; n]],
        }
    }
}

#[inline(always)]
fn clip(v: i32) -> u16 {
    v.clamp(0, 65535) as u16
}

/// One tile: output rows y0..y1 and columns x0..x1, all at least BORDER
/// inside the frame. Buffer index (i, j) is frame (y0 - MARGIN + i,
/// x0 - MARGIN + j).
#[allow(clippy::too_many_arguments)]
fn tile(m: &Mosaic, lab: &Lab, b: &mut Buffers, y0: usize, y1: usize, x0: usize, x1: usize, put: &impl Fn(usize, usize, [u16; 3])) {
    let (ty, tx) = (y0 - MARGIN, x0 - MARGIN);
    let (rows, cols) = (y1 - y0 + 2 * MARGIN, x1 - x0 + 2 * MARGIN);
    let w = m.width;
    let at = |i: usize, j: usize| i * SPAN + j;
    // Green along the row (0) and the column (1).
    for i in 0..rows {
        let r = ty + i;
        let row = &m.data[r * w..];
        for j in 0..cols {
            let c = tx + j;
            if m.color(r, c) == 1 {
                let g = row[c];
                b.green[0][at(i, j)] = g;
                b.green[1][at(i, j)] = g;
                continue;
            }
            let v = row[c] as i32;
            let (gl, gr) = (row[c - 1] as i32, row[c + 1] as i32);
            let hval = ((gl + v + gr) * 2 - row[c - 2] as i32 - row[c + 2] as i32) >> 2;
            b.green[0][at(i, j)] = hval.clamp(gl.min(gr), gl.max(gr)) as u16;
            let (gu, gd) = (m.at(r - 1, c), m.at(r + 1, c));
            let vval = ((gu + v + gd) * 2 - m.at(r - 2, c) - m.at(r + 2, c)) >> 2;
            b.green[1][at(i, j)] = vval.clamp(gu.min(gd), gu.max(gd)) as u16;
        }
    }
    // Red and blue from each direction's green, then Lab: one ring in.
    for d in 0..2 {
        let g = &b.green[d];
        for i in 1..rows - 1 {
            let r = ty + i;
            for j in 1..cols - 1 {
                let c = tx + j;
                let own = m.color(r, c);
                let gc = g[at(i, j)] as i32;
                let mut px = [0u16; 3];
                px[1] = gc as u16;
                if own == 1 {
                    // The row's other color left and right, the column's
                    // above and below.
                    let hc = m.color(r, c + 1);
                    let vc = 2 - hc;
                    px[hc] = clip(gc + ((m.at(r, c - 1) + m.at(r, c + 1) - g[at(i, j - 1)] as i32 - g[at(i, j + 1)] as i32) >> 1));
                    px[vc] = clip(gc + ((m.at(r - 1, c) + m.at(r + 1, c) - g[at(i - 1, j)] as i32 - g[at(i + 1, j)] as i32) >> 1));
                } else {
                    let o = 2 - own;
                    let diag = m.at(r - 1, c - 1) + m.at(r - 1, c + 1) + m.at(r + 1, c - 1) + m.at(r + 1, c + 1)
                        - g[at(i - 1, j - 1)] as i32
                        - g[at(i - 1, j + 1)] as i32
                        - g[at(i + 1, j - 1)] as i32
                        - g[at(i + 1, j + 1)] as i32;
                    px[o] = clip(gc + ((diag + 1) >> 2));
                    px[own] = m.at(r, c) as u16;
                }
                b.rgb[d][at(i, j)] = px;
                b.lab[d][at(i, j)] = lab.of(px);
            }
        }
    }
    // Homogeneity: two rings in.
    for i in 2..rows - 2 {
        for j in 2..cols - 2 {
            let p = at(i, j);
            let n = [p - 1, p + 1, p - SPAN, p + SPAN];
            let mut ld = [[0i32; 4]; 2];
            let mut abd = [[0i32; 4]; 2];
            for d in 0..2 {
                let l = &b.lab[d];
                let c = l[p];
                for k in 0..4 {
                    let q = l[n[k]];
                    ld[d][k] = (c[0] as i32 - q[0] as i32).abs();
                    let (da, db) = (c[1] as i32 - q[1] as i32, c[2] as i32 - q[2] as i32);
                    abd[d][k] = da * da + db * db;
                }
            }
            let leps = ld[0][0].max(ld[0][1]).min(ld[1][2].max(ld[1][3]));
            let abeps = abd[0][0].max(abd[0][1]).min(abd[1][2].max(abd[1][3]));
            for d in 0..2 {
                b.homo[d][p] = (0..4).filter(|&k| ld[d][k] <= leps && abd[d][k] <= abeps).count() as u8;
            }
        }
    }
    // Each output pixel from the more homogeneous direction.
    for i in MARGIN..rows - MARGIN {
        for j in MARGIN..cols - MARGIN {
            let p = at(i, j);
            let mut hm = [0u32; 2];
            for d in 0..2 {
                let h = &b.homo[d];
                for q in [p - SPAN - 1, p - SPAN, p - SPAN + 1, p - 1, p, p + 1, p + SPAN - 1, p + SPAN, p + SPAN + 1] {
                    hm[d] += h[q] as u32;
                }
            }
            let px = if hm[0] != hm[1] {
                b.rgb[(hm[1] > hm[0]) as usize][p]
            } else {
                let (a, c) = (b.rgb[0][p], b.rgb[1][p]);
                [((a[0] as u32 + c[0] as u32) >> 1) as u16, ((a[1] as u32 + c[1] as u32) >> 1) as u16, ((a[2] as u32 + c[2] as u32) >> 1) as u16]
            };
            put(ty + i, tx + j, px);
        }
    }
}
