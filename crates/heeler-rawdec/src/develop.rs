//! A Bayer DNG from its bytes to 16-bit linear RGB in sRGB primaries:
//! the tiles decoded across the cores, the black level subtracted, the
//! white level settled, the camera's white balance scaled in, the
//! demosaic (or, at half size, each 2 by 2 block as one pixel), the
//! highlights clipped or blended, the color matrix, and the camera's
//! orientation, written straight into the output.
//!
//! The numbers follow LibRaw's develop of the same file, which is what
//! Heeler developed these files with before: its integer black level,
//! its white level lowered to the frame's brightest sample when that is
//! within a quarter of it, its scaling and clipping, its matrix.

use std::sync::atomic::{AtomicBool, Ordering};

use heeler_engine::memory;
use rayon::prelude::*;

use crate::ahd::{self, Mosaic, Out};
use crate::dng::Dng;
use crate::{Error, Opts};

/// LibRaw's default threshold for lowering the white level to the
/// frame's brightest sample.
const ADJUST_MAXIMUM: f32 = 0.75;

/// Everything about a file the develop needs, settled before a pixel is
/// decoded, or why the file is not this crate's.
#[derive(Clone, Debug)]
pub struct Plan {
    pub dng: Dng,
    /// The active area: top, left, width, height.
    pub top: usize,
    pub left: usize,
    pub width: usize,
    pub height: usize,
    /// Colors at the active area's first two rows and columns.
    pub pattern: [[u8; 2]; 2],
    /// Black per (row % rows, col % cols) of the active area.
    pub black: Vec<u32>,
    pub black_rows: usize,
    pub black_cols: usize,
    pub white: u32,
    /// The camera's white balance, red, green, blue, green.
    pub cam_mul: [f32; 4],
    pub rgb_cam: [[f32; 3]; 3],
    pub flip: u8,
}

/// Opcode IDs in a DNG opcode list (big-endian: a count, then each
/// opcode's ID, version, flags, size and parameters).
fn opcode_ids(list: &[u8]) -> Option<Vec<u32>> {
    let be = |at: usize| list.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let n = be(0)? as usize;
    let mut at = 4;
    let mut ids = Vec::with_capacity(n.min(64));
    for _ in 0..n {
        ids.push(be(at)?);
        at = at.checked_add(16)?.checked_add(be(at + 12)? as usize)?;
    }
    Some(ids)
}

impl Plan {
    /// The plan for `bytes`, or Unsupported with the reason this crate
    /// leaves the file to LibRaw.
    pub fn new(bytes: &[u8], opts: &Opts) -> Result<Plan, Error> {
        let dng = Dng::parse(bytes)?;
        if !matches!(dng.compression, 1 | 7) {
            return Err(Error::Unsupported("a DNG compression other than none or lossless JPEG"));
        }
        if dng.sample_format != 1 {
            return Err(Error::Unsupported("floating-point samples"));
        }
        if dng.samples != 1 || dng.cfa_layout != 1 || dng.cfa_dim != (2, 2) || !(8..=16).contains(&dng.bits) {
            return Err(Error::Unsupported("not a one-sample 2 by 2 Bayer mosaic"));
        }
        // An odd top or left edge of the active area moves in a row or a
        // column, as LibRaw moves it, so the area starts on a whole 2 by 2.
        let (t, l, b, r) = dng.active;
        let (t, l) = (t + (t & 1), l + (l & 1));
        if t >= b || l >= r {
            return Err(Error::Corrupt("ActiveArea"));
        }
        let mut pattern = [[0u8; 2]; 2];
        let mut count = [0; 3];
        for (i, row) in pattern.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v = dng.color_at(t + i, l + j);
                if *v > 2 {
                    return Err(Error::Unsupported("a CFA color other than red, green or blue"));
                }
                count[*v as usize] += 1;
            }
        }
        if count != [1, 2, 1] || pattern[0][0] == pattern[0][1] || pattern[0][0] == pattern[1][0] {
            return Err(Error::Unsupported("not a Bayer arrangement"));
        }
        if dng.default_scale != (1.0, 1.0) {
            return Err(Error::Unsupported("non-square pixels"));
        }
        if dng.black_delta_h.iter().chain(&dng.black_delta_v).any(|&d| d != 0.0) {
            return Err(Error::Unsupported("black level deltas"));
        }
        // A diagonal camera calibration or analog balance scales the
        // matrix's rows, which the develop matrix normalizes away; any
        // other calibration is declined.
        let diagonal = |m: &Option<Vec<f64>>| m.as_deref().is_none_or(|m| m.len() == 9 && (0..9).all(|k| k % 4 == 0 || m[k] == 0.0));
        if !dng.camera_calibration.iter().all(diagonal) {
            return Err(Error::Unsupported("a camera calibration that mixes colors"));
        }
        // GainMap (9) in OpcodeList2, GainMap or FixVignetteRadial (3) in
        // OpcodeList3: heeler-raw applies those around LibRaw's develop.
        // Every other opcode Heeler's develop leaves alone.
        let t_ = crate::tiff::Tiff::new(bytes).ok_or(Error::Unsupported("not a TIFF"))?;
        for ifd in t_.ifds() {
            if ifd.get(254).and_then(|e| t_.uint(&e)) != Some(0) && ifd.get(254).is_some() {
                continue;
            }
            for (tag, applied) in [(51009u16, &[9u32][..]), (51022, &[3, 9][..])] {
                if let Some(e) = ifd.get(tag) {
                    let ids = t_.bytes(&e).and_then(opcode_ids).ok_or(Error::Corrupt("an opcode list"))?;
                    if ids.iter().any(|id| applied.contains(id)) {
                        return Err(Error::Unsupported("lens shading opcodes"));
                    }
                }
            }
        }
        if dng.compression == 7 {
            // LibRaw reads a tile whose JPEG line, times its components,
            // spans the raw image's width as two tile rows a line, for one
            // writer's layout; such files stay LibRaw's.
            let (at, len) = dng.pieces.spans[0];
            let f = crate::ljpeg::frame(&bytes[at..at + len])?;
            if f.width * f.components * f.height != dng.pieces.width * dng.pieces.height {
                return Err(Error::Unsupported("a tile's JPEG frame is not the tile's size"));
            }
            if f.components > 1 && f.components * f.components * f.width == dng.width {
                return Err(Error::Unsupported("a tile layout LibRaw reads its own way"));
            }
        }
        if !(opts.camera_wb && opts.camera_matrix) {
            return Err(Error::Unsupported("a develop without the camera's white balance and matrix"));
        }
        if !matches!(opts.highlight, 0 | 2) {
            return Err(Error::Unsupported("a highlight rebuild"));
        }
        if !opts.half_size && opts.demosaic != -1 {
            return Err(Error::Unsupported("a demosaic other than the default"));
        }
        let neutral = dng.as_shot_neutral.as_deref().filter(|n| n.len() == 3 && n.iter().all(|&v| v > 0.0)).ok_or(Error::Unsupported("no AsShotNeutral"))?;
        // The reciprocal in single precision, as LibRaw takes it.
        let inv = |v: f64| 1.0f32 / v as f32;
        let cam_mul = [inv(neutral[0]), inv(neutral[1]), inv(neutral[2]), inv(neutral[1])];
        let cm = dng.color_matrix().ok_or(Error::Unsupported("no color matrix"))?.map(|r| r.map(|v| v as f32 as f64));
        let (m, _) = crate::color::srgb_from_camera(&cm).ok_or(Error::Unsupported("a singular color matrix"))?;
        let rgb_cam = m.map(|row| row.map(|v| v as f32));
        let (br, bc) = dng.black_dim;
        // The black pattern over its own period and the CFA's, so one
        // lookup serves both.
        let (rows, cols) = (lcm(br, 2), lcm(bc, 2));
        if rows * cols > 4096 {
            return Err(Error::Unsupported("a black level pattern this large"));
        }
        let black = (0..rows).flat_map(|i| (0..cols).map(move |j| (i, j))).map(|(i, j)| dng.black_at(i, j)).collect();
        let white = dng.white.first().copied().unwrap_or(65535.0).clamp(1.0, 65535.0) as u32;
        Ok(Plan { top: t, left: l, width: r - l, height: b - t, pattern, black, black_rows: rows, black_cols: cols, white, cam_mul, rgb_cam, flip: dng.flip(), dng })
    }

    /// The output's size (turned when the file says so).
    pub fn output_size(&self, half: bool) -> (usize, usize) {
        // At half size an odd last row or column has no block of its own
        // and is left out, as LibRaw leaves it.
        let (w, h) = if half { (self.width / 2, self.height / 2) } else { (self.width, self.height) };
        if self.flip & 4 != 0 { (h, w) } else { (w, h) }
    }

    /// The bytes a develop holds at its peak beyond the file: the mosaic,
    /// the output, the demosaic's workers and the tables.
    pub fn bytes(&self, half: bool) -> Result<usize, memory::MemoryError> {
        let (ow, oh) = self.output_size(half);
        // The unpack's buffers are gone before the demosaic's arrive.
        let working = self.parallel_bytes()?.max(if half { 0 } else { self.demosaic_extra() });
        memory::sum([memory::bytes(self.width, self.height, 1, 2)?, memory::bytes(ow, oh, 3, 2)?, working, TABLES])
    }

    /// Whether the unpack reads each piece's code stream across the cores
    /// (lossless JPEG in fewer pieces than there are cores) rather than
    /// the pieces side by side.
    pub fn parallel_pieces(&self) -> bool {
        self.dng.compression == 7 && self.dng.pieces.spans.len() < rayon::current_num_threads()
    }

    /// What reading one piece across the cores holds: its samples, the
    /// differences each worker reads (a piece's worth, and a little more
    /// where pieces are read again), and the code stream unstuffed.
    fn parallel_bytes(&self) -> Result<usize, memory::MemoryError> {
        if !self.parallel_pieces() {
            return Ok(0);
        }
        let d = &self.dng;
        let largest = d.pieces.spans.iter().map(|&(_, n)| n).max().unwrap_or(0);
        let samples = memory::bytes(d.pieces.width, d.pieces.height, 1, 2)?;
        memory::sum([samples, samples + samples / 2, largest, rayon::current_num_threads() * 64 * 4096 + 65536])
    }

    /// The demosaic's buffers beyond the mosaic and output: one set a
    /// worker.
    pub fn demosaic_extra(&self) -> usize {
        rayon::current_num_threads() * ahd::worker_bytes()
    }
}

/// The linearization table and Lab table, at most.
const TABLES: usize = 65536 * 2 + 65536 * 4 + 4096;

fn lcm(a: usize, b: usize) -> usize {
    let (mut x, mut y) = (a, b);
    while y != 0 {
        (x, y) = (y, x % y);
    }
    a / x * b
}

/// Where a develop's time went.
#[derive(Clone, Copy, Debug, Default)]
pub struct Times {
    pub open: f64,
    pub unpack: f64,
    pub develop: f64,
}

/// The develop's output: what heeler-raw hands its callers.
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub rgb: Vec<u16>,
    pub headroom: f32,
}

fn stopped(stop: Option<&AtomicBool>) -> Result<(), Error> {
    if stop.is_some_and(|s| s.load(Ordering::Relaxed)) { Err(Error::Canceled) } else { Ok(()) }
}

/// Writes `samples`, which start at raw image row `r` and column `c`, into
/// the active area's mosaic: the part inside it, through the
/// linearization table when there is one.
#[inline]
fn put_run(out: Out, p: &Plan, r: usize, c: usize, samples: &[u16], lin: Option<&[u16]>) {
    if r < p.top || r >= p.top + p.height {
        return;
    }
    let from = p.left.saturating_sub(c);
    let to = samples.len().min((p.left + p.width).saturating_sub(c));
    if from >= to {
        return;
    }
    let at = (r - p.top) * p.width + (c + from - p.left);
    // SAFETY: the run lies inside the active area's row r, and each pixel
    // belongs to exactly one tile or strip.
    let dst = unsafe { std::slice::from_raw_parts_mut(out.at(at), to - from) };
    match lin {
        Some(t) => {
            let last = t.len() - 1;
            for (d, &v) in dst.iter_mut().zip(&samples[from..to]) {
                *d = t[(v as usize).min(last)];
            }
        }
        None => dst.copy_from_slice(&samples[from..to]),
    }
}

/// The active area's samples through the linearization table, the tiles
/// or strips decoded side by side.
pub fn unpack(bytes: &[u8], p: &Plan, stop: Option<&AtomicBool>) -> Result<Vec<u16>, Error> {
    let d = &p.dng;
    let mut cfa = memory::vector(p.width * p.height, 0u16, "RAW mosaic")?;
    let out = Out(cfa.as_mut_ptr());
    let (pw, ph) = (d.pieces.width, d.pieces.height);
    let across = d.width.div_ceil(pw);
    let lin = d.linearization.as_deref().filter(|t| !t.is_empty());
    let origin = |i: usize| ((i / across) * ph, (i % across) * pw);
    if d.compression == 1 {
        // Uncompressed: every row of every piece found by arithmetic, so
        // the rows go side by side even when the file is one strip.
        let bits = d.bits as usize;
        let row_bytes = (pw * bits).div_ceil(8);
        let little = bytes.starts_with(b"II");
        let rows: Vec<(usize, usize)> = (0..d.pieces.spans.len()).flat_map(|i| (0..ph).map(move |r| (i, r))).collect();
        rows.par_chunks(64).try_for_each(|chunk| -> Result<(), Error> {
            stopped(stop)?;
            let mut line = vec![0u16; pw];
            for &(i, tr) in chunk {
                let (r0, c0) = origin(i);
                if r0 + tr < p.top || r0 + tr >= p.top + p.height {
                    continue;
                }
                let (at, len) = d.pieces.spans[i];
                let Some(row) = bytes[at..at + len].get(tr * row_bytes..(tr + 1) * row_bytes) else {
                    // A last strip shorter than its rows per strip ends here.
                    if r0 + tr < d.height {
                        return Err(Error::Corrupt("a strip shorter than its rows"));
                    }
                    continue;
                };
                unpack_row(row, bits, little, &mut line);
                put_run(out, p, r0 + tr, c0, &line, lin);
            }
            Ok(())
        })?;
        return Ok(cfa);
    }
    let decode_piece = |i: usize, data: &[u8]| -> Result<(), Error> {
        let (r0, c0) = origin(i);
        // The samples run on across the piece's rows, a JPEG line covering
        // one row, two, or half of one.
        let (mut tr, mut tc) = (0usize, 0usize);
        crate::ljpeg::decode(data, |_, line| {
            let mut rest = line;
            while !rest.is_empty() {
                let n = rest.len().min(pw - tc);
                put_run(out, p, r0 + tr, c0 + tc, &rest[..n], lin);
                rest = &rest[n..];
                tc += n;
                if tc == pw {
                    tc = 0;
                    tr += 1;
                }
            }
        })?;
        Ok(())
    };
    if p.parallel_pieces() {
        // Fewer pieces than cores (often one strip): each piece's code
        // stream read across the cores, then its rows placed side by side.
        let mut samples = memory::vector(pw * ph, 0u16, "RAW lossless JPEG samples")?;
        for (i, &(at, len)) in d.pieces.spans.iter().enumerate() {
            stopped(stop)?;
            let data = &bytes[at..at + len];
            if crate::ljpeg::decode_parallel(data, &mut samples)?.is_none() {
                decode_piece(i, data)?;
                continue;
            }
            let (r0, c0) = origin(i);
            samples.par_chunks(pw).enumerate().for_each(|(tr, row)| put_run(out, p, r0 + tr, c0, row, lin));
        }
        return Ok(cfa);
    }
    d.pieces.spans.par_iter().enumerate().try_for_each(|(i, &(at, len))| -> Result<(), Error> {
        stopped(stop)?;
        decode_piece(i, &bytes[at..at + len])
    })?;
    Ok(cfa)
}

/// One row of uncompressed samples: 8 bits a byte, 16 in the file's byte
/// order, any other depth packed most significant bit first.
fn unpack_row(row: &[u8], bits: usize, little: bool, line: &mut [u16]) {
    match bits {
        8 => line.iter_mut().zip(row).for_each(|(v, &b)| *v = b as u16),
        16 => {
            for (v, b) in line.iter_mut().zip(row.chunks_exact(2)) {
                *v = if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) };
            }
        }
        _ => {
            let (mut acc, mut have, mut at) = (0u64, 0usize, 0usize);
            let mask = (1u64 << bits) - 1;
            for v in line.iter_mut() {
                while have < bits {
                    acc = acc << 8 | *row.get(at).unwrap_or(&0) as u64;
                    at += 1;
                    have += 8;
                }
                have -= bits;
                *v = ((acc >> have) & mask) as u16;
            }
        }
    }
}

/// The numbers the develop applies to every sample.
#[derive(Clone, Copy, Debug)]
pub struct Numbers {
    /// The white level after the black and the frame's brightest sample.
    pub maximum: u32,
    pub scale_mul: [f32; 4],
    pub pre_mul: [f32; 4],
    pub clip: i32,
    pub highlight: i32,
}

/// Subtracts the black level in place and returns the brightest sample.
pub fn subtract_black(cfa: &mut [u16], p: &Plan) -> u16 {
    let w = p.width;
    cfa.par_chunks_mut(w)
        .enumerate()
        .map(|(r, row)| {
            let br = &p.black[(r % p.black_rows) * p.black_cols..][..p.black_cols];
            let mut max = 0u16;
            if br.iter().all(|&b| b == 0) {
                return row.iter().copied().max().unwrap_or(0);
            }
            for (c, v) in row.iter_mut().enumerate() {
                let b = br[c % p.black_cols];
                let x = (*v as u32).saturating_sub(b) as u16;
                *v = x;
                max = max.max(x);
            }
            max
        })
        .max()
        .unwrap_or(0)
}

/// The white level, white balance multipliers and clip level for the
/// develop, from the brightest sample after the black.
pub fn numbers(p: &Plan, opts: &Opts, data_max: u16) -> Numbers {
    let common = p.black.iter().copied().min().unwrap_or(0);
    let mut maximum = p.white.saturating_sub(common);
    if !opts.fixed_white {
        let real = data_max as u32;
        if real > 0 && real < maximum && real as f32 > maximum as f32 * ADJUST_MAXIMUM {
            maximum = real;
        }
    }
    let mut pre_mul = p.cam_mul;
    let (mut dmin, mut dmax) = (f64::MAX, 0.0f64);
    for &v in &pre_mul {
        dmin = dmin.min(v as f64);
        dmax = dmax.max(v as f64);
    }
    if opts.highlight == 0 {
        dmax = dmin;
    }
    let mut scale_mul = [1.0f32; 4];
    for c in 0..4 {
        // In single precision, as LibRaw's build computes it.
        pre_mul[c] /= dmax as f32;
        scale_mul[c] = pre_mul[c] * 65535.0f32 / maximum.max(1) as f32;
    }
    let clip = pre_mul[..3].iter().map(|&m| (65535.0f32 * m) as i32).min().unwrap_or(i32::MAX);
    Numbers { maximum, scale_mul, pre_mul, clip, highlight: opts.highlight }
}

/// One sample scaled by its color's multiplier, clipped to 16 bits.
#[inline(always)]
fn scale(v: u16, mul: f32) -> u16 {
    ((v as f32 * mul) as i32).clamp(0, 65535) as u16
}

/// Scales the mosaic in place by each site's white balance multiplier.
pub fn scale_mosaic(cfa: &mut [u16], p: &Plan, n: &Numbers) {
    let w = p.width;
    cfa.par_chunks_mut(w).enumerate().for_each(|(r, row)| {
        let m = [n.scale_mul[p.pattern[r & 1][0] as usize], n.scale_mul[p.pattern[r & 1][1] as usize]];
        for (c, v) in row.iter_mut().enumerate() {
            *v = scale(*v, m[c & 1]);
        }
    });
}

/// The highlights blended for one pixel of three colors: where any
/// channel passed the clip level, the pixel's chroma rescaled to the
/// clipped pixel's, its lightness kept.
#[inline]
pub fn blend(px: [u16; 3], clip: i32) -> [u16; 3] {
    const TRANS: [[f32; 3]; 3] = [[1.0, 1.0, 1.0], [1.7320508, -1.7320508, 0.0], [-1.0, -1.0, 2.0]];
    const ITRANS: [[f32; 3]; 3] = [[1.0, 0.8660254, -0.5], [1.0, -0.8660254, -0.5], [1.0, 0.0, 1.0]];
    if px.iter().all(|&v| v as i32 <= clip) {
        return px;
    }
    let mut cam = [[0.0f32; 3]; 2];
    for c in 0..3 {
        cam[0][c] = px[c] as f32;
        cam[1][c] = cam[0][c].min(clip as f32);
    }
    let mut lab = [[0.0f32; 3]; 2];
    let mut sum = [0.0f32; 2];
    for i in 0..2 {
        for c in 0..3 {
            let mut acc = 0.0f32;
            for j in 0..3 {
                acc += ((TRANS[c][j] * cam[i][j]) as i32) as f32;
            }
            lab[i][c] = acc;
        }
        for c in 1..3 {
            sum[i] = lab[i][c].mul_add(lab[i][c], sum[i]);
        }
    }
    let chratio = (sum[1] / sum[0]).sqrt();
    for c in 1..3 {
        lab[0][c] *= chratio;
    }
    let mut out = [0u16; 3];
    for c in 0..3 {
        let mut acc = 0.0f32;
        for j in 0..3 {
            acc = ITRANS[c][j].mul_add(lab[0][j], acc);
        }
        out[c] = ((acc / 3.0) as u32) as u16;
    }
    out
}

/// Camera RGB to sRGB primaries for one pixel, clipped to 16 bits.
#[inline(always)]
pub fn convert(px: [u16; 3], m: &[[f32; 3]; 3]) -> [u16; 3] {
    let (a, b, c) = (px[0] as f32, px[1] as f32, px[2] as f32);
    let mut out = [0u16; 3];
    for i in 0..3 {
        let v = m[i][2].mul_add(c, m[i][0].mul_add(a, m[i][1] * b));
        out[i] = (v as i32).clamp(0, 65535) as u16;
    }
    out
}

/// Where pixel (row, col) of a `w` by `h` image lands in the output.
#[inline(always)]
fn to_output(flip: u8, w: usize, h: usize, row: usize, col: usize) -> (usize, usize) {
    let r = if flip & 2 != 0 { h - 1 - row } else { row };
    let c = if flip & 1 != 0 { w - 1 - col } else { col };
    if flip & 4 != 0 { (c, r) } else { (r, c) }
}

/// The whole develop.
pub fn develop(bytes: &[u8], opts: &Opts, stop: Option<&AtomicBool>) -> Result<(Image, Times), Error> {
    let t0 = std::time::Instant::now();
    stopped(stop)?;
    let p = Plan::new(bytes, opts)?;
    let _job = memory::Job::admit(p.bytes(opts.half_size)?, "RAW develop")?;
    let open = t0.elapsed().as_secs_f64();
    let mut cfa = unpack(bytes, &p, stop)?;
    let unpacked = t0.elapsed().as_secs_f64();
    stopped(stop)?;
    let data_max = subtract_black(&mut cfa, &p);
    let n = numbers(&p, opts, data_max);
    scale_mosaic(&mut cfa, &p, &n);
    stopped(stop)?;
    let img = if opts.half_size { half(&cfa, &p, &n)? } else { full(&cfa, &p, &n, stop)? };
    let headroom = if opts.highlight >= 2 { headroom(&n) } else { 1.0 };
    let done = t0.elapsed().as_secs_f64();
    Ok((Image { headroom, ..img }, Times { open, unpack: unpacked - open, develop: done - unpacked }))
}

/// The white balance's headroom: the largest multiplier over the smallest.
fn headroom(n: &Numbers) -> f32 {
    let (mut mn, mut mx) = (0.0f32, 0.0f32);
    for &v in &n.pre_mul {
        if v <= 0.0 {
            continue;
        }
        if mn == 0.0 || v < mn {
            mn = v;
        }
        mx = mx.max(v);
    }
    if mn <= 0.0 || mx <= 0.0 { 1.0 } else { mx / mn }
}

/// The pixel a develop writes for a demosaiced camera pixel.
#[inline(always)]
fn finish(px: [u16; 3], p: &Plan, n: &Numbers) -> [u16; 3] {
    let px = if n.highlight == 2 { blend(px, n.clip) } else { px };
    convert(px, &p.rgb_cam)
}

/// Half size: each 2 by 2 block one pixel, its two greens averaged.
fn half(cfa: &[u16], p: &Plan, n: &Numbers) -> Result<Image, Error> {
    let (w, h) = (p.width, p.height);
    let (hw, hh) = (w / 2, h / 2);
    let (ow, oh) = p.output_size(true);
    let mut rgb = memory::vector(ow * oh * 3, 0u16, "RAW samples")?;
    let out = Out(rgb.as_mut_ptr());
    (0..hh).into_par_iter().for_each(|y| {
        let out = out;
        for x in 0..hw {
            let mut v = [0u32; 4];
            for dy in 0..2 {
                for dx in 0..2 {
                    // The block's second green, on its other row, is kept
                    // apart as a fourth color.
                    let k = p.pattern[dy][dx] as usize;
                    let k = if k == 1 && dy == 1 { 3 } else { k };
                    v[k] = cfa[(2 * y + dy) * w + 2 * x + dx] as u32;
                }
            }
            let px = [v[0] as u16, ((v[1] + v[3]) >> 1) as u16, v[2] as u16];
            let px = finish(px, p, n);
            let (oy, ox) = to_output(p.flip, hw, hh, y, x);
            // SAFETY: each output pixel is written by its own block only.
            unsafe { std::ptr::copy_nonoverlapping(px.as_ptr(), out.at((oy * ow + ox) * 3), 3) };
        }
    });
    Ok(Image { width: ow, height: oh, rgb, headroom: 1.0 })
}

/// Full size: the demosaic, each pixel finished and written as it comes.
fn full(cfa: &[u16], p: &Plan, n: &Numbers, stop: Option<&AtomicBool>) -> Result<Image, Error> {
    let (w, h) = (p.width, p.height);
    let (ow, oh) = p.output_size(false);
    let mut rgb = memory::vector(ow * oh * 3, 0u16, "RAW samples")?;
    let out = Out(rgb.as_mut_ptr());
    let lab = ahd::Lab::new(&p.rgb_cam);
    let m = Mosaic { data: cfa, width: w, height: h, pattern: p.pattern };
    let flip = p.flip;
    ahd::demosaic(&m, &lab, stop, &|r, c, px| {
        let px = finish(px, p, n);
        let (oy, ox) = to_output(flip, w, h, r, c);
        // SAFETY: the demosaic hands each pixel over exactly once.
        unsafe { std::ptr::copy_nonoverlapping(px.as_ptr(), out.at((oy * ow + ox) * 3), 3) };
    })?;
    Ok(Image { width: ow, height: oh, rgb, headroom: 1.0 })
}
