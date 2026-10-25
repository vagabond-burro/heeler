//! The demosaic of an X-Trans mosaic (Fujifilm's 6 by 6 pattern of 8
//! reds, 20 greens and 8 blues), directional and weighed by homogeneity,
//! as AHD (ahd.rs) is for a Bayer mosaic. It is written from the method's
//! plain meaning and held to LibRaw's develop by a tolerance, not to the
//! bit (the owner's decision of 2026-10-22); the weights below were chosen
//! by how close they bring it to LibRaw's output on the corpus.
//!
//! Each pixel's colors are interpolated twice, along the row and along
//! the column. Green at a red or blue site is the nearest green on each
//! side, the nearer weighing more, corrected by half the site's own
//! color's change along the line (its sample less the nearest samples of
//! its color either side). Red and blue are the direction's green plus
//! the color differences, sample less that direction's green, of every
//! sample of the color in the 5 by 5, weighted by the inverse square of
//! the distance. Both candidates go to CIELab; a candidate's roughness at
//! a pixel is its Lab change to its two neighbors along its own direction,
//! and it is homogeneous there when within eight times the smoother
//! candidate's. Counted over the 3 by 3 around each pixel and summed over
//! the 3 by 3 again, the scores weigh the two candidates, each by its
//! score plus one to the fourth power.
//!
//! The frame is worked in independent tiles across the cores. A pixel
//! within BORDER of the frame's edge takes the mean of its 3 by 3
//! neighbors of each missing color instead (the 5 by 5 where the 3 by 3
//! lacks one).

use std::sync::atomic::{AtomicBool, Ordering};

use rayon::prelude::*;

use crate::ahd::Lab;
use crate::Error;

/// Output tile edge; each tile works MARGIN more on every side.
const TILE: usize = 128;
const MARGIN: usize = 5;
const SPAN: usize = TILE + 2 * MARGIN;
/// The frame edge left to the border mean: the green reads four pixels
/// past the tile's margin.
pub const BORDER: usize = MARGIN + 4;
/// Along the row, along the column.
const DIRS: [(isize, isize); 2] = [(0, 1), (1, 0)];
const ND: usize = DIRS.len();
/// How far along a line the green and the site's own color are looked for.
const REACH: isize = 4;

/// What one worker holds while it works a tile, in bytes: the greens, RGB,
/// Lab, roughness and homogeneity of both directions over the tile and
/// margin.
pub const fn worker_bytes() -> usize {
    SPAN * SPAN * ND * (2 + 6 + 6 + 4 + 1)
}

/// An X-Trans mosaic, its colors 0 red, 1 green, 2 blue repeating every
/// six rows and columns from its top left.
pub struct Mosaic<'a> {
    pub data: &'a [u16],
    pub width: usize,
    pub height: usize,
    pub pattern: [[u8; 6]; 6],
}

impl Mosaic<'_> {
    #[inline(always)]
    fn color(&self, r: usize, c: usize) -> usize {
        self.pattern[r % 6][c % 6] as usize
    }
    #[inline(always)]
    fn at(&self, r: usize, c: usize) -> i32 {
        self.data[r * self.width + c] as i32
    }
}

/// Demosaics `m`, handing each finished pixel (row, col, camera RGB) to
/// `put`, every pixel once, from many threads at once. Stops with
/// Canceled between tiles once `stop` is set.
pub fn demosaic(m: &Mosaic, lab: &Lab, stop: Option<&AtomicBool>, put: &(impl Fn(usize, usize, [u16; 3]) + Sync)) -> Result<(), Error> {
    let (h, w) = (m.height, m.width);
    if w < 2 * BORDER + 1 || h < 2 * BORDER + 1 {
        (0..h).into_par_iter().for_each(|r| (0..w).for_each(|c| put(r, c, border_pixel(m, r, c))));
        return Ok(());
    }
    (0..h).into_par_iter().for_each(|r| {
        if r < BORDER || r >= h - BORDER {
            (0..w).for_each(|c| put(r, c, border_pixel(m, r, c)));
        } else {
            (0..BORDER).chain(w - BORDER..w).for_each(|c| put(r, c, border_pixel(m, r, c)));
        }
    });
    let inner = (BORDER, h - BORDER, BORDER, w - BORDER);
    let tiles: Vec<(usize, usize)> = (inner.0..inner.1).step_by(TILE).flat_map(|y| (inner.2..inner.3).step_by(TILE).map(move |x| (y, x))).collect();
    let steps = Steps::new(&m.pattern);
    tiles.par_iter().try_for_each_init(Buffers::new, |b, &(y, x)| {
        if stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
            return Err(Error::Canceled);
        }
        tile(m, lab, &steps, b, y, (y + TILE).min(inner.1), x, (x + TILE).min(inner.3), put);
        Ok(())
    })
}

/// The mean of each missing color over the 3 by 3 around (r, c), or the
/// 5 by 5 where the 3 by 3 has none of it; its own color kept.
fn border_pixel(m: &Mosaic, r: usize, c: usize) -> [u16; 3] {
    let own = m.color(r, c);
    let mut px = [0u16; 3];
    px[own] = m.at(r, c) as u16;
    for k in (0..3).filter(|&k| k != own) {
        for reach in [1, 2] {
            let (mut sum, mut n) = (0u32, 0u32);
            for y in r.saturating_sub(reach)..(r + reach + 1).min(m.height) {
                for x in c.saturating_sub(reach)..(c + reach + 1).min(m.width) {
                    if m.color(y, x) == k {
                        sum += m.at(y, x) as u32;
                        n += 1;
                    }
                }
            }
            if n > 0 {
                px[k] = (sum / n) as u16;
                break;
            }
        }
    }
    px
}

/// For each site of the pattern, what its interpolation reads: per
/// direction, the steps to the nearest green on each side and to the
/// nearest of the site's own color on each side (0 for none within
/// REACH), and per color, that color's samples in the 5 by 5 with their
/// weights (120 over the squared distance).
struct Steps {
    green: [[[(u8, u8); ND]; 6]; 6],
    own: [[[(u8, u8); ND]; 6]; 6],
    near: [[[Vec<(isize, isize, i64)>; 3]; 6]; 6],
}

impl Steps {
    fn new(p: &[[u8; 6]; 6]) -> Steps {
        let color = |r: isize, c: isize| p[r.rem_euclid(6) as usize][c.rem_euclid(6) as usize] as usize;
        let mut green = [[[(0u8, 0u8); ND]; 6]; 6];
        let mut own = [[[(0u8, 0u8); ND]; 6]; 6];
        for r in 0..6isize {
            for c in 0..6isize {
                for (d, &(dy, dx)) in DIRS.iter().enumerate() {
                    let find = |k: usize, s: isize| (1..=REACH).find(|&n| color(r + s * n * dy, c + s * n * dx) == k).unwrap_or(0) as u8;
                    green[r as usize][c as usize][d] = (find(1, 1), find(1, -1));
                    let k = color(r, c);
                    own[r as usize][c as usize][d] = (find(k, 1), find(k, -1));
                }
            }
        }
        let near = std::array::from_fn(|r| {
            std::array::from_fn(|c| {
                std::array::from_fn(|k| {
                    (-2isize..=2)
                        .flat_map(|y| (-2isize..=2).map(move |x| (y, x)))
                        .filter(|&(y, x)| (y, x) != (0, 0) && color(r as isize + y, c as isize + x) == k)
                        .map(|(y, x)| (y, x, 120 / (y * y + x * x) as i64))
                        .collect()
                })
            })
        });
        Steps { green, own, near }
    }
}

struct Buffers {
    green: Vec<[u16; ND]>,
    rgb: Vec<[[u16; 3]; ND]>,
    lab: Vec<[[i16; 3]; ND]>,
    rough: Vec<[u32; ND]>,
    homo: Vec<[u8; ND]>,
}

impl Buffers {
    fn new() -> Self {
        let n = SPAN * SPAN;
        Buffers { green: vec![[0; ND]; n], rgb: vec![[[0; 3]; ND]; n], lab: vec![[[0; 3]; ND]; n], rough: vec![[0; ND]; n], homo: vec![[0; ND]; n] }
    }
}

#[inline(always)]
fn clip(v: i64) -> u16 {
    v.clamp(0, 65535) as u16
}

/// One tile: output rows y0..y1 and columns x0..x1, all at least BORDER
/// inside the frame. Buffer index (i, j) is frame (y0 - MARGIN + i,
/// x0 - MARGIN + j).
#[allow(clippy::too_many_arguments)]
fn tile(m: &Mosaic, lab: &Lab, s: &Steps, b: &mut Buffers, y0: usize, y1: usize, x0: usize, x1: usize, put: &impl Fn(usize, usize, [u16; 3])) {
    let (ty, tx) = (y0 - MARGIN, x0 - MARGIN);
    let (rows, cols) = (y1 - y0 + 2 * MARGIN, x1 - x0 + 2 * MARGIN);
    let at = |i: usize, j: usize| i * SPAN + j;
    let off = |p: usize, dy: isize, dx: isize| (p as isize + dy * SPAN as isize + dx) as usize;
    // Green, each direction.
    for i in 0..rows {
        let r = ty + i;
        for j in 0..cols {
            let c = tx + j;
            let v = m.at(r, c) as i64;
            if m.color(r, c) == 1 {
                b.green[at(i, j)] = [v as u16; ND];
                continue;
            }
            for (d, &(dy, dx)) in DIRS.iter().enumerate() {
                let sample = |n: isize| m.at((r as isize + n * dy) as usize, (c as isize + n * dx) as usize) as i64;
                // The two sides' samples at steps a and -z, the nearer
                // weighing more; one side's alone where the other has none.
                let between = |(a, z): (u8, u8)| -> Option<i64> {
                    let (a, z) = (a as isize, z as isize);
                    match (a, z) {
                        (0, 0) => None,
                        (a, 0) => Some(sample(a)),
                        (0, z) => Some(sample(-z)),
                        (a, z) => Some((sample(a) * z as i64 + sample(-z) * a as i64) / (a + z) as i64),
                    }
                };
                let g = between(s.green[r % 6][c % 6][d]).unwrap_or(v);
                let est = match between(s.own[r % 6][c % 6][d]) {
                    Some(o) => g + (v - o) / 2,
                    None => g,
                };
                b.green[at(i, j)][d] = clip(est);
            }
        }
    }
    // Red and blue, then Lab: two rings in.
    for i in 2..rows - 2 {
        let r = ty + i;
        for j in 2..cols - 2 {
            let c = tx + j;
            let p = at(i, j);
            let own = m.color(r, c);
            let near = &s.near[r % 6][c % 6];
            for d in 0..ND {
                let gc = b.green[p][d] as i64;
                let mut px = [0u16; 3];
                px[1] = gc as u16;
                px[own] = m.at(r, c) as u16;
                for k in (0..3).filter(|&k| k != own && k != 1) {
                    let (mut diff, mut weight) = (0i64, 0i64);
                    for &(dy, dx, wt) in &near[k] {
                        let sample = m.at((r as isize + dy) as usize, (c as isize + dx) as usize) as i64;
                        diff += wt * (sample - b.green[off(p, dy, dx)][d] as i64);
                        weight += wt;
                    }
                    px[k] = clip(gc + (diff + weight / 2).div_euclid(weight));
                }
                b.rgb[p][d] = px;
                b.lab[p][d] = lab.of(px);
            }
        }
    }
    // Roughness along each direction: three rings in.
    for i in 3..rows - 3 {
        for j in 3..cols - 3 {
            let p = at(i, j);
            for (d, &(dy, dx)) in DIRS.iter().enumerate() {
                let c = b.lab[p][d];
                let mut sum = 0u32;
                for q in [off(p, dy, dx), off(p, -dy, -dx)] {
                    let n = b.lab[q][d];
                    let (dl, da, db) = (c[0] as i32 - n[0] as i32, c[1] as i32 - n[1] as i32, c[2] as i32 - n[2] as i32);
                    sum = sum.saturating_add((dl * dl + da * da + db * db) as u32);
                }
                b.rough[p][d] = sum;
            }
        }
    }
    // Homogeneity over the 3 by 3: four rings in.
    for i in 4..rows - 4 {
        for j in 4..cols - 4 {
            let p = at(i, j);
            let mut h = [0u8; ND];
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let q = b.rough[off(p, dy, dx)];
                    let limit = q.iter().min().unwrap().saturating_mul(8);
                    for d in 0..ND {
                        h[d] += (q[d] <= limit) as u8;
                    }
                }
            }
            b.homo[p] = h;
        }
    }
    // Each output pixel, the candidates weighed by their scores over the
    // 3 by 3: MARGIN rings in.
    for i in MARGIN..rows - MARGIN {
        for j in MARGIN..cols - MARGIN {
            let p = at(i, j);
            let mut score = [0u64; ND];
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let h = b.homo[off(p, dy, dx)];
                    for d in 0..ND {
                        score[d] += h[d] as u64;
                    }
                }
            }
            let (mut sum, mut weight) = ([0u64; 3], 0u64);
            for d in 0..ND {
                let wt = (score[d] + 1).pow(4);
                for k in 0..3 {
                    sum[k] += wt * b.rgb[p][d][k] as u64;
                }
                weight += wt;
            }
            put(ty + i, tx + j, sum.map(|v| ((v + weight / 2) / weight) as u16));
        }
    }
}
