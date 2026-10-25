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
//! within a quarter of it, its scaling and clipping. The color is the DNG
//! specification's model for the shot's white (or, for the comparisons,
//! LibRaw's daylight matrix).

use std::sync::atomic::{AtomicBool, Ordering};

use heeler_engine::memory;
use rayon::prelude::*;

use crate::ahd::{self, Mosaic, Out};
use crate::dng::{Coding, Dng, Format};
use crate::gain_map::{self, PixelGains};
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
    /// An X-Trans sensor's colors from the active area's top left, for
    /// its 6 by 6 pattern (`pattern` then holds its first 2 by 2).
    pub xtrans: Option<[[u8; 6]; 6]>,
    /// Black per (row % rows, col % cols) of the active area.
    pub black: Vec<u32>,
    pub black_rows: usize,
    pub black_cols: usize,
    pub white: u32,
    /// The camera's white balance, red, green, blue, green.
    pub cam_mul: [f32; 4],
    pub rgb_cam: [[f32; 3]; 3],
    pub flip: u8,
    /// OpcodeList2's GainMaps, applied to the mosaic before the black is
    /// taken off, and OpcodeList3's GainMaps and FixVignetteRadials,
    /// applied to each pixel between the highlights and the color matrix:
    /// the lens shading phones, drones and some cameras write.
    pub gains2: Vec<gain_map::GainMap>,
    pub stage3: Vec<gain_map::Stage3>,
    /// How many readings the parallel lossless JPEG decode makes of each
    /// piece of its stream (ljpeg::table_period): 1 for one Huffman table.
    pub table_period: usize,
}

impl Plan {
    /// The plan for `bytes`, or Unsupported with the reason this crate
    /// leaves the file to LibRaw.
    pub fn new(bytes: &[u8], opts: &Opts) -> Result<Plan, Error> {
        let dng = Dng::open(bytes)?;
        if dng.photometric != 32803 {
            return Err(Error::Unsupported("not a CFA image"));
        }
        // Integers uncompressed or in lossless JPEG; floats (HDR merges)
        // uncompressed or Deflated with the floating-point predictor.
        match (dng.sample_format, dng.compression, dng.predictor) {
            (1, 1 | 7, _) if (8..=16).contains(&dng.bits) => {}
            (1, 32767, _) if dng.coding == Coding::SonyBlocks => {}
            (1, 0, _) if matches!(&dng.coding, Coding::Crx(_)) && (8..=16).contains(&dng.bits) => {}
            (1, 0, _) if matches!(&dng.coding, Coding::CrxWavelet(_)) && (8..=16).contains(&dng.bits) => {}
            (1, 34713, _) if matches!(&dng.coding, Coding::NikonHuffman(_)) && (12..=14).contains(&dng.bits) => {}
            (1, 34316, _) if matches!(&dng.coding, Coding::Panasonic(_)) && (12..=16).contains(&dng.bits) => {}
            (1, 65535, _) if matches!(&dng.coding, Coding::Pentax(_)) && (12..=14).contains(&dng.bits) => {}
            (3, 1, 1) | (3, 8, 3 | 34894 | 34895) if matches!(dng.bits, 16 | 24 | 32) && dng.linearization.is_none() => {}
            _ => return Err(Error::Unsupported("a sample format, depth or compression not read here")),
        }
        let x_trans = dng.format == Format::Raf && dng.cfa_dim == (6, 6);
        if dng.samples != 1 || dng.cfa_layout != 1 || !(dng.cfa_dim == (2, 2) || x_trans) {
            return Err(Error::Unsupported("not a one-sample 2 by 2 Bayer mosaic"));
        }
        // An odd top or left edge of a DNG's active area moves in a row or
        // a column, as LibRaw moves it, so the area starts on a whole 2 by
        // 2. Another format's area is LibRaw's own already (geometry.rs).
        let (t, l, b, r) = dng.active;
        let (t, l) = if dng.is_dng() { (t + (t & 1), l + (l & 1)) } else { (t, l) };
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
        let xtrans: Option<[[u8; 6]; 6]> = x_trans.then(|| std::array::from_fn(|i| std::array::from_fn(|j| dng.color_at(t + i, l + j))));
        if let Some(x) = &xtrans {
            // Eight reds, twenty greens and eight blues.
            let mut n = [0; 3];
            x.iter().flatten().for_each(|&c| n[c.min(2) as usize] += 1);
            if x.iter().flatten().any(|&c| c > 2) || n != [8, 20, 8] {
                return Err(Error::Unsupported("not an X-Trans arrangement"));
            }
        } else if count != [1, 2, 1] || pattern[0][0] == pattern[0][1] || pattern[0][0] == pattern[1][0] {
            return Err(Error::Unsupported("not a Bayer arrangement"));
        }
        if dng.default_scale != (1.0, 1.0) {
            return Err(Error::Unsupported("non-square pixels"));
        }
        if dng.black_delta_h.iter().chain(&dng.black_delta_v).any(|&d| d != 0.0) {
            return Err(Error::Unsupported("black level deltas"));
        }
        // With LibRaw's color, a diagonal camera calibration or analog
        // balance scales the matrix's rows, which the develop matrix
        // normalizes away; any other calibration is declined. The DNG
        // model takes any.
        let diagonal = |m: &Option<Vec<f64>>| m.as_deref().is_none_or(|m| m.len() == 9 && (0..9).all(|k| k % 4 == 0 || m[k] == 0.0));
        if opts.libraw_color && !dng.camera_calibration.iter().all(diagonal) {
            return Err(Error::Unsupported("a camera calibration that mixes colors"));
        }
        let mut table_period = 1;
        if dng.compression == 7 {
            // LibRaw reads a tile whose JPEG line, times its components,
            // spans the raw image's width as two tile rows a line, for one
            // writer's layout; such files stay LibRaw's.
            let (at, len) = dng.pieces.spans[0];
            let f = crate::ljpeg::frame(&bytes[at..at + len])?;
            if f.width * f.components * f.height != dng.pieces.width * dng.pieces.height {
                return Err(Error::Unsupported("a tile's JPEG frame is not the tile's size"));
            }
            table_period = crate::ljpeg::table_period(&f);
            if dng.coding == Coding::Tiff && f.components > 1 && f.components * f.components * f.width == dng.width {
                return Err(Error::Unsupported("a tile layout LibRaw reads its own way"));
            }
        }
        if !(opts.camera_wb && opts.camera_matrix) {
            return Err(Error::Unsupported("a develop without the camera's white balance and matrix"));
        }
        if !matches!(opts.highlight, 0 | 2) {
            return Err(Error::Unsupported("a highlight rebuild"));
        }
        if xtrans.is_some() && !opts.half_size {
            return Err(Error::Unsupported("the X-Trans demosaic"));
        }
        if !opts.half_size && opts.demosaic != -1 {
            return Err(Error::Unsupported("a demosaic other than the default"));
        }
        // A file that states no balance develops in daylight, as LibRaw
        // falls back to it: the neutral of the camera's D65 calibration.
        let daylight = if dng.as_shot_neutral.is_none() && dng.cam_mul.is_none() { daylight_neutral(&dng) } else { None };
        let neutral = dng.as_shot_neutral.as_deref().or(daylight.as_deref()).filter(|n| n.len() == 3 && n.iter().all(|&v| v > 0.0)).ok_or(Error::Unsupported("no AsShotNeutral"))?;
        // A DNG's: the reciprocal in single precision, as LibRaw takes it;
        // another format's as the file states it.
        let inv = |v: f64| 1.0f32 / v as f32;
        let cam_mul = dng.cam_mul.unwrap_or([inv(neutral[0]), inv(neutral[1]), inv(neutral[2]), inv(neutral[1])]);
        let rgb_cam = develop_matrix(&dng, [neutral[0], neutral[1], neutral[2]], opts.libraw_color)?.map(|row| row.map(|v| v as f32));
        let (br, bc) = dng.black_dim;
        // The black pattern over its own period and the CFA's, so one
        // lookup serves both.
        let n = if x_trans { 6 } else { 2 };
        let (rows, cols) = (lcm(br, n), lcm(bc, n));
        if rows * cols > 4096 {
            return Err(Error::Unsupported("a black level pattern this large"));
        }
        let black = (0..rows).flat_map(|i| (0..cols).map(move |j| (i, j))).map(|(i, j)| dng.black_at(i, j)).collect();
        let white = dng.white.first().copied().unwrap_or(65535.0).clamp(1.0, 65535.0) as u32;
        // Other opcodes are left alone, as heeler-raw leaves them around
        // LibRaw's develop.
        let gains2 = gain_map::parse_list(&dng.opcodes[1]);
        let stage3 = gain_map::parse_list3(&dng.opcodes[2]);
        Ok(Plan { top: t, left: l, width: r - l, height: b - t, pattern, xtrans, black, black_rows: rows, black_cols: cols, white, cam_mul, rgb_cam, flip: dng.flip(), gains2, stage3, table_period, dng })
    }

    /// The output's size (turned when the file says so).
    pub fn output_size(&self, half: bool) -> (usize, usize) {
        let (w, h) = if half { self.half_size() } else { (self.width, self.height) };
        if self.flip & 4 != 0 { (h, w) } else { (w, h) }
    }

    /// The bytes a develop holds at its peak beyond the file: the mosaic,
    /// the output, the demosaic's workers and the tables.
    pub fn bytes(&self, half: bool) -> Result<usize, memory::MemoryError> {
        let (ow, oh) = self.output_size(half);
        // The unpack's buffers are gone before the demosaic's arrive.
        let working = self.parallel_bytes()?.max(if half { 0 } else { self.demosaic_extra() });
        // A black measured on the border holds the whole frame a while.
        let frame = if self.dng.border_black { memory::bytes(self.dng.width, self.dng.height, 1, 2)? } else { 0 };
        memory::sum([memory::bytes(self.width, self.height, 1, 2)?, memory::bytes(ow, oh, 3, 2)?, working, TABLES, self.pixel_gains(half).bytes(), frame])
    }

    /// The image the stage 3 opcodes see: the active area, or at half size
    /// its whole 2 by 2 blocks (the half-size image's own size).
    fn stage3_size(&self, half: bool) -> (usize, usize) {
        if half { self.half_size() } else { (self.width, self.height) }
    }

    /// The half-size image's size, unturned. A Bayer area's odd last row
    /// or column has no block of its own and is left out, as LibRaw leaves
    /// it; an X-Trans area's makes blocks of its own, as LibRaw's does.
    fn half_size(&self) -> (usize, usize) {
        if self.xtrans.is_some() { (self.width.div_ceil(2), self.height.div_ceil(2)) } else { (self.width / 2, self.height / 2) }
    }

    /// OpcodeList3 worked out for the develop's image.
    pub fn pixel_gains(&self, half: bool) -> PixelGains {
        let (w, h) = self.stage3_size(half);
        PixelGains::new(&self.stage3, w as u32, h as u32, 3)
    }

    /// Whether the unpack reads each piece's code stream across the cores
    /// (lossless JPEG in fewer pieces than there are cores) rather than
    /// the pieces side by side.
    pub fn parallel_pieces(&self) -> bool {
        self.dng.compression == 7 && self.dng.pieces.spans.len() < rayon::current_num_threads()
    }

    /// Whether the samples are floats.
    pub fn float(&self) -> bool {
        self.dng.sample_format == 3
    }

    /// What reading one piece across the cores holds: its samples, the
    /// differences each worker reads (a piece's worth for each place in the
    /// Huffman tables' cycle, and a little more where pieces are read
    /// again), and the code stream unstuffed.
    fn parallel_bytes(&self) -> Result<usize, memory::MemoryError> {
        if self.float() {
            // A piece at a time a worker: its floats and its inflated bytes.
            let d = &self.dng;
            let piece = memory::bytes(d.pieces.width, d.pieces.height, 1, 4 + d.bits as usize / 8)?;
            return memory::bytes(rayon::current_num_threads().min(d.pieces.spans.len()), 1, 1, piece);
        }
        if !self.parallel_pieces() {
            return Ok(0);
        }
        let d = &self.dng;
        let largest = d.pieces.spans.iter().map(|&(_, n)| n).max().unwrap_or(0);
        let samples = memory::bytes(d.pieces.width, d.pieces.height, 1, 2)?;
        // The differences, read once for each place in the tables' cycle,
        // and a little more where pieces are read again.
        let diffs = memory::bytes(samples, self.table_period, 1, 1)?;
        memory::sum([samples, diffs + samples / 2, largest, rayon::current_num_threads() * 64 * 4096 + 65536])
    }

    /// The demosaic's buffers beyond the mosaic and output: one set a
    /// worker.
    pub fn demosaic_extra(&self) -> usize {
        rayon::current_num_threads() * ahd::worker_bytes()
    }
}

/// How far (mean CIEDE2000 over the Classic chart's patches) a profile's
/// ForwardMatrix may develop colors from its own ColorMatrix before the
/// ForwardMatrix is taken for a placeholder. Profiles made with care agree
/// within about 3; some hand-made and phone profiles carry a ForwardMatrix
/// that does not describe the camera.
const FORWARD_AGREEMENT: f64 = 5.0;

/// The develop matrix by the DNG specification's color model for the
/// shot's white: the profile's two calibrations weighted by that white's
/// color temperature, through the ForwardMatrix where the profile has one
/// that agrees with its ColorMatrix (FORWARD_AGREEMENT), else through the
/// ColorMatrix. A profile that also has hue and saturation or look tables
/// is taken through its ColorMatrix too, since such a profile's
/// ForwardMatrix can leave most of the color to the tables, which this
/// develop does not apply.
fn dng_color(dng: &Dng, neutral: [f64; 3]) -> Result<[[f64; 3]; 3], Error> {
    let profile = dng.profile();
    let by_color = crate::color::Profile { forward_matrix: [None, None], ..profile.clone() };
    let color = crate::color::camera_to_xyz_d50(&by_color, neutral).ok_or(Error::Unsupported("no usable color matrix"))?;
    let forward = (profile.forward_matrix[0].is_some() && !dng.profile_tables)
        .then(|| crate::color::camera_to_xyz_d50(&profile, neutral))
        .flatten()
        .filter(|f| crate::color::disagreement(&color, f).is_some_and(|d| d <= FORWARD_AGREEMENT));
    crate::color::srgb_from_balanced(&forward.unwrap_or(color), neutral).ok_or(Error::Unsupported("a color matrix that loses the white"))
}

/// The camera (white-balanced) to linear sRGB matrix a develop of `dng`
/// multiplies by, for the camera white `neutral`: the DNG model's, or with
/// `libraw_color` LibRaw's (the daylight ColorMatrix alone; where the file
/// has more than one, its values in single precision, as LibRaw then
/// holds them, which the corpus bears out on every file but one).
pub fn develop_matrix(dng: &Dng, neutral: [f64; 3], libraw_color: bool) -> Result<[[f64; 3]; 3], Error> {
    if libraw_color {
        let single = dng.color_matrix.iter().filter(|m| m.is_some()).count() > 1;
        let cm = dng.color_matrix().ok_or(Error::Unsupported("no color matrix"))?.map(|r| r.map(|v| if single { v as f32 as f64 } else { v }));
        Ok(crate::color::srgb_from_camera(&cm).ok_or(Error::Unsupported("a singular color matrix"))?.0)
    } else {
        dng_color(dng, neutral)
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

/// put_run for samples two columns apart: samples[i] at row r, column
/// c + 2i, those inside the active area.
fn put_sites(out: Out, p: &Plan, r: usize, c: usize, samples: &[u16]) {
    if r < p.top || r >= p.top + p.height {
        return;
    }
    let row = (r - p.top) * p.width;
    for (i, &v) in samples.iter().enumerate() {
        let col = c + 2 * i;
        if col < p.left {
            continue;
        }
        if col >= p.left + p.width {
            break;
        }
        // SAFETY: inside the active area's row r; each site belongs to
        // exactly one plane.
        unsafe { *out.at(row + col - p.left) = v };
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
    if p.float() {
        // Floats, a piece a worker, each sample's whole part taken; LibRaw
        // takes them so while the frame's brightest lies within 4096 to
        // 32767 (its float conversion's defaults) and rescales otherwise,
        // which leaves such a file to it.
        let little = bytes.starts_with(b"II");
        let max = d.pieces.spans.par_iter().enumerate().map(|(i, &(at, len))| -> Result<f32, Error> {
            stopped(stop)?;
            let data = &bytes[at..at + len];
            let v = if d.compression == 8 { crate::deflate::floats(data, pw, ph, d.bits, d.predictor)? } else { crate::deflate::uncompressed_floats(data, pw, ph, d.bits, little)? };
            let (r0, c0) = origin(i);
            let (rows, cols) = ((v.len() / pw).min(d.height.saturating_sub(r0)), pw.min(d.width - c0));
            if r0 + v.len() / pw < (r0 + ph).min(d.height) {
                return Err(Error::Corrupt("a piece shorter than its rows"));
            }
            let mut max = 0f32;
            let mut line = vec![0u16; pw];
            for tr in 0..rows {
                for (dst, &x) in line.iter_mut().zip(&v[tr * pw..tr * pw + cols]) {
                    if !(x >= 0.0 && x <= 65535.0) {
                        return Err(Error::Unsupported("float samples outside 0 to 65535"));
                    }
                    max = max.max(x);
                    *dst = x as u16;
                }
                put_run(out, p, r0 + tr, c0, &line[..cols], None);
            }
            Ok(max)
        }).try_reduce(|| 0f32, |a, b| Ok(a.max(b)))?;
        if !(4096.0..=32767.0).contains(&max) {
            return Err(Error::Unsupported("float samples LibRaw would rescale"));
        }
        return Ok(cfa);
    }
    if d.compression == 1 && matches!(d.coding, Coding::Tiff | Coding::PackedLow | Coding::BigWords | Coding::LittleWords) {
        // Uncompressed: every row of every piece found by arithmetic, so
        // the rows go side by side even when the file is one strip.
        let bits = d.bits as usize;
        let row_bytes = (pw * bits).div_ceil(8);
        let little = (bytes.starts_with(b"II") && d.coding != Coding::BigWords) || d.coding == Coding::LittleWords;
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
                if d.coding == Coding::PackedLow {
                    unpack_row_low(row, bits, &mut line);
                } else {
                    unpack_row(row, bits, little, &mut line);
                }
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
    if d.coding == Coding::SonyTiles {
        // Each tile's JPEG line is two rows of the tile: components 0 and 1
        // side by side, then 2 and 3.
        d.pieces.spans.par_iter().enumerate().try_for_each(|(i, &(at, len))| -> Result<(), Error> {
            stopped(stop)?;
            let (r0, c0) = origin(i);
            let (mut top, mut bottom) = (vec![0u16; pw], vec![0u16; pw]);
            crate::ljpeg::decode(&bytes[at..at + len], |y, line| {
                for (x, px) in line.chunks_exact(4).enumerate().take(pw / 2) {
                    top[2 * x] = px[0];
                    top[2 * x + 1] = px[1];
                    bottom[2 * x] = px[2];
                    bottom[2 * x + 1] = px[3];
                }
                put_run(out, p, r0 + 2 * y, c0, &top, lin);
                put_run(out, p, r0 + 2 * y + 1, c0, &bottom, lin);
            })?;
            Ok(())
        })?;
        return Ok(cfa);
    }
    if let Coding::Crx(planes) = &d.coding {
        // The planes side by side, each line's samples to every second
        // column of every second row of its tile.
        planes.par_iter().try_for_each(|pl| -> Result<(), Error> {
            stopped(stop)?;
            crate::crx::decode_plane(&bytes[pl.at..pl.at + pl.len], pl.width, pl.height, d.bits, |y, line| {
                put_sites(out, p, pl.y0 + 2 * y + pl.site.0, pl.x0 + pl.site.1, line);
            })
        })?;
        return Ok(cfa);
    }
    if let Coding::CrxWavelet(w) = &d.coding {
        // The four planes side by side, each rebuilt whole, then its rows
        // to every second column of every second row.
        (0..4).into_par_iter().try_for_each(|site| -> Result<(), Error> {
            stopped(stop)?;
            let tiles: Vec<[crate::crx::Band; 10]> = w.sites[site]
                .iter()
                .map(|bands| -> Result<[crate::crx::Band; 10], Error> {
                    let v: Vec<_> = bands.iter().map(|b| crate::crx::Band { data: &bytes[b.at..b.at + b.len], q: b.q }).collect();
                    v.try_into().map_err(|_| Error::Corrupt("a C-RAW tile's plane without ten subbands"))
                })
                .collect::<Result<_, _>>()?;
            let plane = match &w.map {
                // The second version: each coefficient's step from the
                // tile's map of quantizers.
                Some(map) => {
                    let fields: [u32; 10] = std::array::from_fn(|i| w.sites[site][0][i].q);
                    crate::crx::reconstruct_plane_with(&tiles, w.width, w.height, w.tile, d.bits, &crate::crx::map_steps(map, fields))?
                }
                None => crate::crx::reconstruct_plane(&tiles, w.width, w.height, w.tile, d.bits)?,
            };
            let (dy, dx) = (site >> 1, site & 1);
            for y in 0..w.height {
                put_sites(out, p, 2 * y + dy, dx, &plane[y * w.width..(y + 1) * w.width]);
            }
            Ok(())
        })?;
        return Ok(cfa);
    }
    if let Coding::NikonHuffman(h) = &d.coding {
        // One stream, row after row.
        let (at, len) = d.pieces.spans[0];
        stopped(stop)?;
        // Rows below the image area are not decoded: some files' streams
        // stop at its last row.
        crate::nef::decode(&bytes[at..at + len], d.width, d.height.min(p.top + p.height), h, |r, line| put_run(out, p, r, 0, line, lin))?;
        return Ok(cfa);
    }
    if let Coding::CanonCrw(c) = &d.coding {
        // One stream, row after row; rows below the image area are not
        // decoded.
        let (at, len) = d.pieces.spans[0];
        stopped(stop)?;
        crate::crw::decode(&bytes[at..at + len], d.width, d.height.min(p.top + p.height), c, |r, line| put_run(out, p, r, 0, line, lin))?;
        return Ok(cfa);
    }
    if let Coding::Fuji(f) = &d.coding {
        // Blocks of columns across the cores; rows below the image area
        // are not decoded.
        stopped(stop)?;
        crate::fuji::decode(bytes, f, d.height.min(p.top + p.height), |r, line| put_run(out, p, r, 0, line, lin))?;
        return Ok(cfa);
    }
    if let Coding::Headerless(layout) = &d.coding {
        // Rows found by arithmetic, across the cores; rows below the image
        // area are not decoded.
        stopped(stop)?;
        crate::headerless::decode(bytes, d.width, d.height, d.height.min(p.top + p.height), layout, |r, line| put_run(out, p, r, 0, line, lin))?;
        return Ok(cfa);
    }
    if let Coding::PhaseOne(p1) = &d.coding {
        // Rows each at their own offset, across the cores; rows below the
        // image area are not decoded.
        let (at, len) = d.pieces.spans[0];
        stopped(stop)?;
        crate::iiq::decode(&bytes[at..at + len], d.width, d.height.min(p.top + p.height), p1, |r, line| put_run(out, p, r, 0, line, lin))?;
        return Ok(cfa);
    }
    if let Coding::Pentax(code) = &d.coding {
        // One stream, row after row; rows below the image area are not
        // decoded.
        let (at, len) = d.pieces.spans[0];
        stopped(stop)?;
        crate::pef::decode(&bytes[at..at + len], d.width, d.height.min(p.top + p.height), code, |r, line| put_run(out, p, r, 0, line, lin))?;
        return Ok(cfa);
    }
    if let Coding::Olympus(layout) = d.coding {
        // One span (the fields: whole strips); rows below the image area
        // are not decoded.
        let (at, len) = d.pieces.spans[0];
        let data = bytes.get(at..at + len).unwrap_or(&[]);
        stopped(stop)?;
        let rows = d.height.min(p.top + p.height);
        let put = |r: usize, line: &[u16]| put_run(out, p, r, 0, line, lin);
        match layout {
            crate::orf::Olympus::Compressed(header) => crate::orf::decode(data, header, d.width, rows, put)?,
            crate::orf::Olympus::Padded => crate::orf::decode_padded(data, d.width, rows, put)?,
            crate::orf::Olympus::Words => crate::orf::decode_words(data, d.width, rows, put)?,
            crate::orf::Olympus::Fields(per_strip) => crate::orf::decode_fields(bytes, &d.pieces.spans, d.width, d.height, rows, per_strip, put)?,
        }
        return Ok(cfa);
    }
    if let Coding::Panasonic(coding) = &d.coding {
        // Packets in one span, or tiles side by side; rows below the image
        // area are not decoded.
        stopped(stop)?;
        crate::rw2::decode(bytes, &d.pieces.spans, d.width, d.height.min(p.top + p.height), coding, |r, c, line| put_run(out, p, r, c, line, lin))?;
        return Ok(cfa);
    }
    if d.coding == Coding::SonyBlocks {
        let (at, len) = d.pieces.spans[0];
        stopped(stop)?;
        crate::sony::decode(&bytes[at..at + len], d.width, d.height, &|r, line| put_run(out, p, r, 0, line, lin));
        return Ok(cfa);
    }
    if let Coding::Slices([n, w, last]) = d.coding {
        // One strip, its samples in slices: decoded whole (across the cores
        // where the stream allows), then each frame row gathered from them.
        let (at, len) = d.pieces.spans[0];
        let data = &bytes[at..at + len];
        stopped(stop)?;
        let mut samples = memory::vector(d.width * d.height, 0u16, "RAW lossless JPEG samples")?;
        if crate::ljpeg::decode_intervals(data, &mut samples)?.is_none() && crate::ljpeg::decode_parallel(data, &mut samples)?.is_none() {
            let mut k = 0;
            crate::ljpeg::decode(data, |_, line| {
                let end = (k + line.len()).min(samples.len());
                samples[k..end].copy_from_slice(&line[..end - k]);
                k = end;
            })?;
        }
        stopped(stop)?;
        let h = d.height;
        (0..h).into_par_iter().for_each(|r| {
            let mut base = 0;
            for s in 0..=n {
                let ws = if s < n { w } else { last };
                put_run(out, p, r, s * w, &samples[base + r * ws..base + (r + 1) * ws], lin);
                base += ws * h;
            }
        });
        return Ok(cfa);
    }
    if p.parallel_pieces() {
        // Fewer pieces than cores (often one strip): each piece's code
        // stream read across the cores (each restart interval from its own
        // marker, or pieces that fall into step), then its rows placed side
        // by side.
        let mut samples = memory::vector(pw * ph, 0u16, "RAW lossless JPEG samples")?;
        for (i, &(at, len)) in d.pieces.spans.iter().enumerate() {
            stopped(stop)?;
            let data = &bytes[at..at + len];
            if crate::ljpeg::decode_intervals(data, &mut samples)?.is_none() && crate::ljpeg::decode_parallel(data, &mut samples)?.is_none() {
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

/// The masked border's columns a black level is measured over: those
/// left of the image area, two in from either side (the outermost and
/// those next to the image can carry light).
const BORDER_MARGIN: usize = 2;

/// The frame's black level from its masked border: for each site of the
/// 2 by 2 pattern (counted from the image area's top left), the rounded
/// mean of the masked columns left of the area, over the area's rows.
/// A headerless file's border takes in light in places (the firmware's
/// frames differ from camera to camera, and LibRaw names some by another
/// camera's size): its black is measured over the masked columns on
/// either side of the area that read darkest, within 6 of the darkest
/// (columns below 16 are dead, not dark), each site's mean rounded down.
pub fn border_black(frame: &[u16], frame_width: usize, p: &Plan) -> Result<[u32; 4], Error> {
    let left: Vec<usize> = (BORDER_MARGIN..p.left.saturating_sub(BORDER_MARGIN)).collect();
    // Where the left border is too narrow to measure (a CRW of the Pro1 or
    // S30), the darkest columns of both, as a headerless file's.
    let cols = if p.dng.format == Format::Headerless || left.len() < 4 { darkest_columns(frame, frame_width, p) } else { left };
    if cols.len() < 4 {
        return Err(Error::Unsupported("no masked border to measure black on"));
    }
    let (sum, n) = (p.top..p.top + p.height)
        .into_par_iter()
        .map(|r| {
            let mut sum = [0u64; 4];
            let mut n = [0u64; 4];
            for &c in &cols {
                // The site counted from the area's top left (c - left has
                // the parity of c + left).
                let k = ((r - p.top) & 1) << 1 | ((c + p.left) & 1);
                sum[k] += frame[r * frame_width + c] as u64;
                n[k] += 1;
            }
            (sum, n)
        })
        .reduce(|| ([0; 4], [0; 4]), |a, b| ([0, 1, 2, 3].map(|i| a.0[i] + b.0[i]), [0, 1, 2, 3].map(|i| a.1[i] + b.1[i])));
    // The mean rounded (a CRW's, as LibRaw takes it, and a headerless
    // file's rounded down).
    let half = if matches!(p.dng.format, Format::Crw | Format::Headerless) { 0 } else { 1 };
    Ok([0, 1, 2, 3].map(|i| ((sum[i] + half * n[i] / 2) / n[i].max(1)) as u32))
}

/// The masked columns left and right of the image area that read darkest
/// over its rows (border_black).
fn darkest_columns(frame: &[u16], frame_width: usize, p: &Plan) -> Vec<usize> {
    let border: Vec<usize> = (0..p.left).chain(p.left + p.width..frame_width).collect();
    let mean = |c: usize| (p.top..p.top + p.height).map(|r| frame[r * frame_width + c] as u64).sum::<u64>() as f64 / p.height.max(1) as f64;
    let means: Vec<(usize, f64)> = border.par_iter().map(|&c| (c, mean(c))).filter(|&(_, m)| m >= 16.0).collect();
    let darkest = means.iter().map(|&(_, m)| m).fold(f64::MAX, f64::min);
    means.into_iter().filter(|&(_, m)| m <= darkest + 6.0).map(|(c, _)| c).collect()
}

/// LibRaw takes a Panasonic file's samples of 0 as bad ones: each becomes
/// the mean, rounded down, of the samples of its color two rows or columns
/// away (and diagonally) inside the image area that are not 0, in the
/// order the rows run, as found against LibRaw's mosaic before its
/// demosaic; so a headerless file whose layout says so (headerless.rs).
/// Another format's mosaic is left as it is.
pub fn fill_zeros(cfa: &mut [u16], p: &Plan) {
    let bad = p.dng.format == Format::Rw2 || matches!(p.dng.coding, Coding::Headerless(l) if l.zeros_bad);
    if !bad {
        return;
    }
    let (w, h) = (p.width, p.height);
    let zeros: Vec<usize> = cfa.par_iter().enumerate().filter(|(_, &v)| v == 0).map(|(i, _)| i).collect();
    for i in zeros {
        let (r, c) = (i / w, i % w);
        let (mut sum, mut n) = (0u32, 0u32);
        for rr in [r.wrapping_sub(2), r, r + 2] {
            for cc in [c.wrapping_sub(2), c, c + 2] {
                if (rr, cc) == (r, c) || rr >= h || cc >= w {
                    continue;
                }
                let v = cfa[rr * w + cc];
                if v > 0 {
                    sum += v as u32;
                    n += 1;
                }
            }
        }
        if n > 0 {
            cfa[i] = (sum / n) as u16;
        }
    }
}

/// The image area's samples, as unpack gives them, and the black level
/// measured on the masked border (border_black), from the whole frame
/// decoded.
pub fn unpack_measuring_black(bytes: &[u8], p: &Plan, stop: Option<&AtomicBool>) -> Result<(Vec<u16>, [u32; 4]), Error> {
    let (fw, fh) = (p.dng.width, p.dng.height);
    let whole = Plan { top: 0, left: 0, width: fw, height: fh, ..p.clone() };
    let frame = unpack(bytes, &whole, stop)?;
    let black = border_black(&frame, fw, p)?;
    let mut cfa = memory::vector(p.width * p.height, 0u16, "RAW mosaic")?;
    cfa.par_chunks_mut(p.width).enumerate().for_each(|(r, row)| {
        let at = (p.top + r) * fw + p.left;
        row.copy_from_slice(&frame[at..at + p.width]);
    });
    Ok((cfa, black))
}

/// One row of uncompressed samples: 8 bits a byte, 16 in the file's byte
/// order, any other depth packed most significant bit first.
pub fn unpack_row(row: &[u8], bits: usize, little: bool, line: &mut [u16]) {
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

/// One row of samples packed least significant bits first: each sample's
/// low bits in the lower bits of the byte it starts in.
pub fn unpack_row_low(row: &[u8], bits: usize, line: &mut [u16]) {
    let (mut acc, mut have, mut at) = (0u64, 0usize, 0usize);
    let mask = (1u64 << bits) - 1;
    for v in line.iter_mut() {
        while have < bits {
            acc |= (*row.get(at).unwrap_or(&0) as u64) << have;
            at += 1;
            have += 8;
        }
        *v = (acc & mask) as u16;
        acc >>= bits;
        have -= bits;
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

/// The camera's neutral under D65 (EXIF light source 21): its D65 color
/// matrix applied to D65's white (x 0.3127, y 0.3290), green 1.
fn daylight_neutral(dng: &Dng) -> Option<Vec<f64>> {
    let k = dng.illuminant.iter().position(|&i| i == 21)?;
    let m = dng.color_matrix[k].as_ref().filter(|m| m.len() == 9)?;
    let xyz = [0.3127 / 0.3290, 1.0, (1.0 - 0.3127 - 0.3290) / 0.3290];
    let n: Vec<f64> = (0..3).map(|r| (0..3).map(|c| m[r * 3 + c] * xyz[c]).sum()).collect();
    (n[1] > 0.0).then(|| n.iter().map(|v| v / n[1]).collect())
}

/// The brightest sample of the whole 2 by 2 blocks (the half-size
/// develop's).
fn blocks_max(cfa: &[u16], p: &Plan) -> u16 {
    let (w, h) = (p.width, p.height);
    cfa[..(h / 2 * 2) * w].par_chunks(w).map(|row| row[..w / 2 * 2].iter().copied().max().unwrap_or(0)).max().unwrap_or(0)
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
    // The green on blue's row takes the fourth multiplier, the second
    // green's (a DNG's is the first green's; a CR2's can differ).
    if let Some(x) = &p.xtrans {
        cfa.par_chunks_mut(w).enumerate().for_each(|(r, row)| {
            let m: [f32; 6] = std::array::from_fn(|j| n.scale_mul[x[r % 6][j] as usize]);
            for (c, v) in row.iter_mut().enumerate() {
                *v = scale(*v, m[c % 6]);
            }
        });
        return;
    }
    let mul = |i: usize, j: usize| {
        let c = p.pattern[i][j] as usize;
        n.scale_mul[if c == 1 && p.pattern[i].contains(&2) { 3 } else { c }]
    };
    cfa.par_chunks_mut(w).enumerate().for_each(|(r, row)| {
        let m = [mul(r & 1, 0), mul(r & 1, 1)];
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
            sum[i] = crate::fmadd(lab[i][c], lab[i][c], sum[i]);
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
            acc = crate::fmadd(ITRANS[c][j], lab[0][j], acc);
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
        let v = crate::fmadd(m[i][2], c, crate::fmadd(m[i][0], a, m[i][1] * b));
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
    develop_plan(bytes, &p, opts, stop, t0)
}

/// The develop of `bytes` by a plan made for it (Plan::new with `opts`),
/// which the comparisons with LibRaw may give LibRaw's own matrix.
#[doc(hidden)]
pub fn develop_with(bytes: &[u8], p: &Plan, opts: &Opts, stop: Option<&AtomicBool>) -> Result<(Image, Times), Error> {
    develop_plan(bytes, p, opts, stop, std::time::Instant::now())
}

fn develop_plan(bytes: &[u8], p: &Plan, opts: &Opts, stop: Option<&AtomicBool>, t0: std::time::Instant) -> Result<(Image, Times), Error> {
    let _job = memory::Job::admit(p.bytes(opts.half_size)?, "RAW develop")?;
    let open = t0.elapsed().as_secs_f64();
    let measured;
    let (mut cfa, p) = if p.dng.border_black {
        let (cfa, black) = unpack_measuring_black(bytes, p, stop)?;
        measured = Plan { black: black.to_vec(), black_rows: 2, black_cols: 2, ..p.clone() };
        (cfa, &measured)
    } else {
        (unpack(bytes, p, stop)?, p)
    };
    fill_zeros(&mut cfa, p);
    let unpacked = t0.elapsed().as_secs_f64();
    stopped(stop)?;
    if !p.gains2.is_empty() {
        let mut img = gain_map::Cfa { data: &mut cfa, pitch: p.width, top: 0, left: 0, height: p.height as u32, width: p.width as u32 };
        gain_map::apply_cfa(&p.gains2, &mut img, |r, c| p.black[(r as usize % p.black_rows) * p.black_cols + c as usize % p.black_cols]);
    }
    let data_max = subtract_black(&mut cfa, &p);
    // At half size the odd last row and column make no block, and LibRaw
    // leaves them out of the brightest sample too.
    let data_max = if opts.half_size && (p.width % 2 == 1 || p.height % 2 == 1) && p.xtrans.is_none() { blocks_max(&cfa, p) } else { data_max };
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

/// The pixel a develop writes for demosaiced camera pixel (row, col):
/// the highlights, the stage 3 opcodes, the color matrix.
#[inline(always)]
fn finish(px: [u16; 3], row: usize, col: usize, p: &Plan, n: &Numbers, g: &PixelGains) -> [u16; 3] {
    let mut px = if n.highlight == 2 { blend(px, n.clip) } else { px };
    if !g.is_empty() {
        g.apply(row, col, &mut px);
    }
    convert(px, &p.rgb_cam)
}

/// Half size: each 2 by 2 block one pixel, its two greens averaged.
fn half(cfa: &[u16], p: &Plan, n: &Numbers) -> Result<Image, Error> {
    if let Some(x) = &p.xtrans {
        return half_xtrans(cfa, p, n, x);
    }
    let (w, h) = (p.width, p.height);
    let (hw, hh) = (w / 2, h / 2);
    let (ow, oh) = p.output_size(true);
    let mut rgb = memory::vector(ow * oh * 3, 0u16, "RAW samples")?;
    let out = Out(rgb.as_mut_ptr());
    let g = p.pixel_gains(true);
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
            let px = finish(px, y, x, p, n, &g);
            let (oy, ox) = to_output(p.flip, hw, hh, y, x);
            // SAFETY: each output pixel is written by its own block only.
            unsafe { std::ptr::copy_nonoverlapping(px.as_ptr(), out.at((oy * ow + ox) * 3), 3) };
        }
    });
    Ok(Image { width: ow, height: oh, rgb, headroom: 1.0 })
}

/// Half size of an X-Trans mosaic (an odd last row or column making
/// blocks of its own): each 2 by 2 block one pixel of the
/// last sample of each color it holds; a block of greens alone (every
/// third block across and down) takes its red and blue as the mean of its
/// left and right neighbors' (none at the first and last columns).
fn half_xtrans(cfa: &[u16], p: &Plan, n: &Numbers, x: &[[u8; 6]; 6]) -> Result<Image, Error> {
    let (w, h) = (p.width, p.height);
    let (hw, hh) = p.half_size();
    let (ow, oh) = p.output_size(true);
    let mut rgb = memory::vector(ow * oh * 3, 0u16, "RAW samples")?;
    let out = Out(rgb.as_mut_ptr());
    let g = p.pixel_gains(true);
    // A block's three colors; 0 for one it lacks.
    let block = |y: usize, bx: usize| {
        let mut v = [0u16; 3];
        for d in 0..4 {
            let (r, c) = (2 * y + d / 2, 2 * bx + d % 2);
            if r >= h || c >= w {
                continue;
            }
            v[x[r % 6][c % 6] as usize] = cfa[r * w + c];
        }
        v
    };
    (0..hh).into_par_iter().for_each(|y| {
        let out = out;
        let mut prev = [0u16; 3];
        let mut here = block(y, 0);
        for bx in 0..hw {
            let next = if bx + 1 < hw { block(y, bx + 1) } else { [0; 3] };
            let mut px = here;
            let greens = (0..4).all(|d| x[(2 * y + d / 2) % 6][(2 * bx + d % 2) % 6] == 1);
            if greens && bx > 0 && bx + 1 < hw {
                px[0] = ((prev[0] as u32 + next[0] as u32) >> 1) as u16;
                px[2] = ((prev[2] as u32 + next[2] as u32) >> 1) as u16;
            }
            let fin = finish(px, y, bx, p, n, &g);
            let (oy, ox) = to_output(p.flip, hw, hh, y, bx);
            // SAFETY: each output pixel is written by its own block only.
            unsafe { std::ptr::copy_nonoverlapping(fin.as_ptr(), out.at((oy * ow + ox) * 3), 3) };
            prev = here;
            here = next;
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
    let g = p.pixel_gains(false);
    ahd::demosaic(&m, &lab, stop, &|r, c, px| {
        let px = finish(px, r, c, p, n, &g);
        let (oy, ox) = to_output(flip, w, h, r, c);
        // SAFETY: the demosaic hands each pixel over exactly once.
        unsafe { std::ptr::copy_nonoverlapping(px.as_ptr(), out.at((oy * ow + ox) * 3), 3) };
    })?;
    Ok(Image { width: ow, height: oh, rgb, headroom: 1.0 })
}
