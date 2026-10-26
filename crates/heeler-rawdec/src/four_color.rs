//! A mosaic of four colors (the CMYG and RGBE sensors of some early
//! compact cameras) from its unpacked samples to 16-bit linear RGB, as
//! LibRaw develops it at its default quality, every rule found against
//! LibRaw's own develop of such files (its stages and its output, full
//! size and half, the highlights clipped and blended), to the bit.
//!
//! The colors are LibRaw's four indices, 0 to 3, laid out by a pattern of
//! 8 rows and 2 columns from the image area's top left (a 2 by 2 pattern
//! repeats in it). The develop:
//!
//! - The black level of each color is taken off, and the brightest sample
//!   left lowers the white level as the three-color develop's does.
//! - Each sample is scaled by its color's multiplier (the four divided by
//!   the smallest when the highlights are clipped, by the largest when
//!   they are blended), times 65535 over the white level.
//! - The frame's edge, two pixels wide, is interpolated apart; see
//!   `demosaic`.
//! - At full size, the demosaic is the variable number of gradients
//!   (Chang, Cheung and Pang, 1999); see `demosaic`.
//! - At half size, each 2 by 2 block is one pixel of its four samples.
//! - The highlights are clipped (left as they are) or blended; see `blend`.
//! - The four colors go to the output through LibRaw's 3 by 4 matrix.

use std::sync::atomic::{AtomicBool, Ordering};

use heeler_engine::memory;
use rayon::prelude::*;

use crate::develop::{Image, Numbers, Plan};
use crate::{Error, Opts};

/// What a four-color plan holds beyond a Bayer one's: the pattern and
/// the 3 by 4 matrix (Plan's black table, white level, balance, in
/// LibRaw's color order, and flip serve as they are).
#[derive(Clone, Debug)]
pub struct Four {
    /// The color (0 to 3) at each row (modulo 8) and column (modulo 2) of
    /// the image area.
    pub pattern: [[u8; 2]; 8],
    /// Camera colors to the output's.
    pub rgb_cam: [[f32; 4]; 3],
}

impl Four {
    #[inline(always)]
    fn color(&self, r: usize, c: usize) -> usize {
        self.pattern[r & 7][c & 1] as usize
    }
}

fn stopped(stop: Option<&AtomicBool>) -> Result<(), Error> {
    if stop.is_some_and(|s| s.load(Ordering::Relaxed)) { Err(Error::Canceled) } else { Ok(()) }
}

/// The white level, the multipliers and the clip level, from the
/// brightest sample after the black: the three-color develop's
/// (develop::numbers, over the four multipliers), the clip level the
/// smallest of the four colors'.
pub fn numbers(p: &Plan, opts: &Opts, data_max: u16) -> Numbers {
    let n = crate::develop::numbers(p, opts, data_max);
    let clip = n.pre_mul.iter().map(|&m| (65535.0f32 * m) as i32).min().unwrap_or(i32::MAX);
    Numbers { clip, ..n }
}

/// Scales each sample by its color's multiplier, clipped to 16 bits.
pub fn scale(cfa: &mut [u16], width: usize, f: &Four, n: &Numbers) {
    cfa.par_chunks_mut(width).enumerate().for_each(|(r, row)| {
        let m = [n.scale_mul[f.color(r, 0)], n.scale_mul[f.color(r, 1)]];
        for (c, v) in row.iter_mut().enumerate() {
            *v = ((*v as f32 * m[c & 1]) as i32).clamp(0, 65535) as u16;
        }
    });
}

/// The eight directions, N, NE, E, SE, S, SW, W, NW, each a quarter turn
/// clockwise from the one two before.
const DIRS: [(i32, i32); 8] = [(-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1), (-1, -1)];

/// A gradient's pair of samples (offsets from the site, in N's or NE's
/// frame) and its weight.
type Term = ((i32, i32), (i32, i32), i32);

/// The gradient's pairs of samples for N (and, turned, E, S, W) with
/// their weights: every pair between rows -2 and 0 and between rows -1
/// and 1, within the three middle columns, at most one column apart; the
/// two in the middle column weigh 2, the rest 1. (On a 2 by 2 pattern only
/// the six straight up and down are ever of one color.)
const ORTH_TERMS: [Term; 14] = [
    ((-2, 0), (0, 0), 2),
    ((-1, 0), (1, 0), 2),
    ((-2, -1), (0, -1), 1),
    ((-2, 1), (0, 1), 1),
    ((-1, -1), (1, -1), 1),
    ((-1, 1), (1, 1), 1),
    ((-2, -1), (0, 0), 1),
    ((-2, 1), (0, 0), 1),
    ((-2, 0), (0, -1), 1),
    ((-2, 0), (0, 1), 1),
    ((-1, -1), (1, 0), 1),
    ((-1, 1), (1, 0), 1),
    ((-1, 0), (1, -1), 1),
    ((-1, 0), (1, 1), 1),
];

/// The gradient's pairs for NE (and, turned, SE, SW, NW): the four two
/// diagonal steps apart on the diagonal through the center and the two
/// beside it, weight 2, and twelve a knight's move apart, weight 1 (never
/// of one color on a 2 by 2 pattern; the PowerShot Pro70's 8 by 2 one has
/// them).
const DIAG_TERMS: [Term; 16] = [
    ((-2, 1), (0, -1), 2),
    ((-1, 2), (1, 0), 2),
    ((-2, 2), (0, 0), 2),
    ((-1, 1), (1, -1), 2),
    ((-2, 1), (-1, -1), 1),
    ((-1, 2), (1, 1), 1),
    ((-2, 2), (-1, 0), 1),
    ((-2, 2), (0, 1), 1),
    ((-2, 1), (0, 0), 1),
    ((-1, 2), (0, 0), 1),
    ((-2, 0), (0, -1), 1),
    ((0, 2), (1, 0), 1),
    ((-1, 0), (1, -1), 1),
    ((0, 1), (1, -1), 1),
    ((-1, 1), (0, -1), 1),
    ((-1, 1), (1, 0), 1),
];

/// `p` turned a quarter clockwise `q` times.
fn turn(q: usize, (y, x): (i32, i32)) -> (i32, i32) {
    let (mut y, mut x) = (y, x);
    for _ in 0..q {
        (y, x) = (x, -y);
    }
    (y, x)
}

/// What the demosaic weighs at one site of the pattern: each direction's
/// gradient pairs (offsets into the mosaic and weight) and its estimate of
/// each color (offsets and weights, and the weights' sum).
struct Phase {
    terms: [Vec<(isize, isize, i32)>; 8],
    taps: [[Vec<(isize, i32)>; 4]; 8],
    total: [[i32; 4]; 8],
}

fn phases(f: &Four, width: usize) -> Vec<Phase> {
    let w = width as isize;
    let at = |(y, x): (i32, i32)| y as isize * w + x as isize;
    (0..16usize)
        .map(|k| {
            let (pr, pc) = ((k / 2) as i32, (k % 2) as i32);
            // The color at an offset from this site (rows modulo 8, columns
            // modulo 2, from a site 8 rows down so offsets stay positive).
            let fc = |(y, x): (i32, i32)| f.color((pr + 8 + y) as usize, (pc + 8 + x) as usize);
            let own = fc((0, 0));
            let mut terms: [Vec<(isize, isize, i32)>; 8] = Default::default();
            let mut taps: [[Vec<(isize, i32)>; 4]; 8] = Default::default();
            let mut total = [[0i32; 4]; 8];
            for d in 0..8 {
                let list: &[Term] = if d % 2 == 0 { &ORTH_TERMS } else { &DIAG_TERMS };
                for &(a, b, wt) in list {
                    let (a, b) = (turn(d / 2, a), turn(d / 2, b));
                    if fc(a) == fc(b) {
                        terms[d].push((at(a), at(b), wt));
                    }
                }
                // The 3 by 3 around the neighbor in this direction, weighted
                // 4 at its center, 2 at its edges, 1 at its corners; the
                // site's own color, where the sample two steps on is of it
                // too, the mean of the two alone.
                let (uy, ux) = DIRS[d];
                let line = fc((2 * uy, 2 * ux)) == own;
                for y in -1..=1i32 {
                    for x in -1..=1i32 {
                        let p = (uy + y, ux + x);
                        let c = fc(p);
                        if line && c == own {
                            continue;
                        }
                        let wt = (2 - y.abs()) * (2 - x.abs());
                        taps[d][c].push((at(p), wt));
                        total[d][c] += wt;
                    }
                }
                if line {
                    taps[d][own].push((0, 1));
                    taps[d][own].push((at((2 * uy, 2 * ux)), 1));
                    total[d][own] += 2;
                }
            }
            Phase { terms, taps, total }
        })
        .collect()
}

/// The demosaic of the scaled mosaic `cfa` (`width` by `height`), each
/// pixel's four colors handed to `put` (row, column, colors) once.
///
/// Two pixels and more from the edge, the variable number of gradients: eight
/// gradients, one a direction, each the weighted sum of the absolute
/// differences of the pairs of same-colored samples its table lists
/// (ORTH_TERMS, DIAG_TERMS, turned to the direction). The threshold is the
/// smallest gradient plus half the largest (integers, the half rounded
/// down); every direction whose gradient is no more than it is taken. A
/// direction's estimate of each color is the weighted mean of that color's
/// samples in the 3 by 3 around the neighbor in that direction, weights 4,
/// 2 and 1 from its center out (for the site's own color, where the
/// sample two steps on is of the same color, the mean of the site and that
/// sample alone), each mean an integer rounded toward zero. A missing color
/// is the site's sample plus the sum over the directions taken of that
/// color's estimates less the site color's, divided by how many were taken
/// (rounded toward zero), clipped to 16 bits.
///
/// In the band of two pixels at the edge: a missing color is the mean of
/// that color's samples among the pixel's 3 by 3 neighbors, weighted 2 at
/// the sides and 1 at the corners on the band's inner ring, unweighted on
/// the outermost (where the neighbors past the edge are left out), rounded
/// toward zero. The site's own color is always its sample.
pub fn demosaic(cfa: &[u16], width: usize, height: usize, f: &Four, stop: Option<&AtomicBool>, put: &(impl Fn(usize, usize, [u16; 4]) + Sync)) -> Result<(), Error> {
    let ph = phases(f, width);
    let (w, h) = (width, height);
    let stop_flag = std::sync::atomic::AtomicBool::new(false);
    (0..h).into_par_iter().for_each(|r| {
        if stop_flag.load(Ordering::Relaxed) {
            return;
        }
        if r % 64 == 0 && stop.is_some_and(|s| s.load(Ordering::Relaxed)) {
            stop_flag.store(true, Ordering::Relaxed);
            return;
        }
        let inner = r >= 2 && r + 2 < h;
        for c in 0..w {
            let own = f.color(r, c);
            let i = r * w + c;
            if !inner || c < 2 || c + 2 >= w {
                put(r, c, edge(cfa, w, h, f, r, c));
                continue;
            }
            let p = &ph[(r & 7) * 2 + (c & 1)];
            let v = |o: isize| cfa[(i as isize + o) as usize] as i32;
            let mut g = [0i32; 8];
            for d in 0..8 {
                g[d] = p.terms[d].iter().map(|&(a, b, wt)| wt * (v(a) - v(b)).abs()).sum();
            }
            let (mut gmin, mut gmax) = (g[0], g[0]);
            for &x in &g[1..] {
                gmin = gmin.min(x);
                gmax = gmax.max(x);
            }
            let thold = gmin + (gmax >> 1);
            let mut sum = [0i32; 4];
            let mut n = 0i32;
            for d in 0..8 {
                if g[d] > thold {
                    continue;
                }
                n += 1;
                for k in 0..4 {
                    if p.total[d][k] == 0 {
                        continue;
                    }
                    let s: i32 = p.taps[d][k].iter().map(|&(o, wt)| wt * v(o)).sum();
                    sum[k] += s / p.total[d][k];
                }
            }
            let x = cfa[i] as i32;
            let mut px = [0u16; 4];
            for k in 0..4 {
                px[k] = if k == own { x as u16 } else { (x + (sum[k] - sum[own]) / n).clamp(0, 65535) as u16 };
            }
            put(r, c, px);
        }
    });
    if stop_flag.load(Ordering::Relaxed) {
        return Err(Error::Canceled);
    }
    Ok(())
}

/// A pixel in the band two pixels wide at the frame's edge (`demosaic`).
fn edge(cfa: &[u16], w: usize, h: usize, f: &Four, r: usize, c: usize) -> [u16; 4] {
    let outer = r == 0 || c == 0 || r + 1 == h || c + 1 == w;
    let own = f.color(r, c);
    let (mut s, mut k) = ([0u32; 4], [0u32; 4]);
    for y in r.saturating_sub(1)..(r + 2).min(h) {
        for x in c.saturating_sub(1)..(c + 2).min(w) {
            if (y, x) == (r, c) {
                continue;
            }
            let wt = if !outer && (y == r || x == c) { 2 } else { 1 };
            let cc = f.color(y, x);
            s[cc] += wt * cfa[y * w + x] as u32;
            k[cc] += wt;
        }
    }
    std::array::from_fn(|cc| if cc == own { cfa[r * w + c] } else if k[cc] > 0 { (s[cc] / k[cc]) as u16 } else { 0 })
}

/// The highlights blended for one pixel of four colors: where any color
/// passed the clip level, the pixel's chroma rescaled to the clipped
/// pixel's, its lightness kept. LibRaw's three-color blend with four
/// colors: lightness the sum of the four, chroma the three sign patterns
/// [1, -1, 1, -1], [1, 1, -1, -1] and [1, -1, -1, 1] in that order (the
/// order fixes the float rounding), the ratio the square root of the
/// clipped pixel's sum of squared chroma over the pixel's, back through
/// the same patterns and divided by 4, rounded toward zero.
#[inline]
pub fn blend(px: [u16; 4], clip: i32) -> [u16; 4] {
    const TRANS: [[f32; 4]; 4] = [[1.0, 1.0, 1.0, 1.0], [1.0, -1.0, 1.0, -1.0], [1.0, 1.0, -1.0, -1.0], [1.0, -1.0, -1.0, 1.0]];
    if px.iter().all(|&v| v as i32 <= clip) {
        return px;
    }
    let mut cam = [[0.0f32; 4]; 2];
    for c in 0..4 {
        cam[0][c] = px[c] as f32;
        cam[1][c] = cam[0][c].min(clip as f32);
    }
    let mut lab = [[0.0f32; 4]; 2];
    let mut sum = [0.0f32; 2];
    for i in 0..2 {
        for c in 0..4 {
            let mut acc = 0.0f32;
            for j in 0..4 {
                acc += ((TRANS[c][j] * cam[i][j]) as i32) as f32;
            }
            lab[i][c] = acc;
        }
        for c in 1..4 {
            sum[i] = crate::fmadd(lab[i][c], lab[i][c], sum[i]);
        }
    }
    let chratio = (sum[1] / sum[0]).sqrt();
    for c in 1..4 {
        lab[0][c] *= chratio;
    }
    let mut out = [0u16; 4];
    for c in 0..4 {
        let mut acc = 0.0f32;
        for j in 0..4 {
            // The patterns are their own inverse (times 4).
            acc = crate::fmadd(TRANS[j][c], lab[0][j], acc);
        }
        out[c] = ((acc / 4.0) as u32) as u16;
    }
    out
}

/// The four camera colors to the output's through LibRaw's 3 by 4 matrix,
/// clipped to 16 bits: each row's products summed as LibRaw's build sums
/// them, the first two first, then the third and the fourth.
#[inline(always)]
pub fn convert(px: [u16; 4], m: &[[f32; 4]; 3]) -> [u16; 3] {
    let x = px.map(|v| v as f32);
    let mut out = [0u16; 3];
    for i in 0..3 {
        let v = crate::fmadd(m[i][3], x[3], crate::fmadd(m[i][2], x[2], crate::fmadd(m[i][0], x[0], m[i][1] * x[1])));
        out[i] = (v as i32).clamp(0, 65535) as u16;
    }
    out
}

/// The develop of a four-color mosaic: `cfa` the plan's image area as
/// unpacked (black not yet off), the black, white level, balance and flip
/// the plan's, at the size and in the highlight mode `opts` asks (0 clip,
/// 2 blend).
///
/// At half size, the odd last row and column make no block, and LibRaw
/// leaves them out of the brightest sample too; each block is one pixel of
/// its four samples, one of each color.
pub fn develop(mut cfa: Vec<u16>, p: &Plan, f: &Four, opts: &Opts, stop: Option<&AtomicBool>) -> Result<Image, Error> {
    let (w, h) = (p.width, p.height);
    if cfa.len() != w * h || w < 2 || h < 2 {
        return Err(Error::Corrupt("a four-color mosaic of the wrong size"));
    }
    if !matches!(opts.highlight, 0 | 2) {
        return Err(Error::Unsupported("a highlight mode other than clip and blend"));
    }
    stopped(stop)?;
    let data_max = crate::develop::subtract_black(&mut cfa, p);
    let data_max = if opts.half_size && (w % 2 == 1 || h % 2 == 1) {
        cfa[..(h / 2 * 2) * w].par_chunks(w).map(|row| row[..w / 2 * 2].iter().copied().max().unwrap_or(0)).max().unwrap_or(0)
    } else {
        data_max
    };
    let n = numbers(p, opts, data_max);
    scale(&mut cfa, w, f, &n);
    stopped(stop)?;
    let (iw, ih) = if opts.half_size { (w / 2, h / 2) } else { (w, h) };
    let (ow, oh) = if p.flip & 4 != 0 { (ih, iw) } else { (iw, ih) };
    let mut rgb = memory::vector(ow * oh * 3, 0u16, "RAW samples")?;
    let out = crate::ahd::Out(rgb.as_mut_ptr());
    let finish = |px: [u16; 4], r: usize, c: usize| {
        let px = if n.highlight == 2 { blend(px, n.clip) } else { px };
        let px = convert(px, &f.rgb_cam);
        let (oy, ox) = crate::develop::to_output(p.flip, iw, ih, r, c);
        // SAFETY: each output pixel is written by its own source pixel.
        unsafe { std::ptr::copy_nonoverlapping(px.as_ptr(), out.at((oy * ow + ox) * 3), 3) };
    };
    if opts.half_size {
        (0..ih).into_par_iter().for_each(|y| {
            for x in 0..iw {
                let mut px = [0u16; 4];
                for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                    let (r, c) = (2 * y + dy, 2 * x + dx);
                    px[f.color(r, c)] = cfa[r * w + c];
                }
                finish(px, y, x);
            }
        });
    } else {
        demosaic(&cfa, w, h, f, stop, &|r, c, px| finish(px, r, c))?;
    }
    let headroom = if opts.highlight >= 2 { crate::develop::headroom(&n) } else { 1.0 };
    Ok(Image { width: ow, height: oh, rgb, headroom })
}

/// The frame of a Sony SRF (the DSC-F828's): its last `width` by `height`
/// 16-bit samples of the file (IFD0's StripByteCounts long; IFD0 states
/// no StripOffsets), big-endian, enciphered as 32-bit big-endian words
/// with the SR2 keystream (sony.rs's sr2_decipher) from `key`, the
/// keystream starting at the frame's first word. Found from the file
/// against LibRaw's frame, the key recovered from the keystream itself
/// (its first four ring words are four steps of the key's LCG); where the
/// file keeps the key is not settled here.
pub fn unpack_srf(bytes: &[u8], width: usize, height: usize, key: u32) -> Result<Vec<u16>, Error> {
    let len = width * height * 2;
    let at = bytes.len().checked_sub(len).ok_or(Error::Corrupt("an SRF shorter than its frame"))?;
    let mut data = memory::vector(len, 0u8, "RAW frame bytes")?;
    data.copy_from_slice(&bytes[at..]);
    crate::sony::sr2_decipher(&mut data, key);
    let mut frame = memory::vector(width * height, 0u16, "RAW frame")?;
    frame.par_iter_mut().zip(data.par_chunks_exact(2)).for_each(|(v, b)| *v = u16::from_be_bytes([b[0], b[1]]));
    Ok(frame)
}
