//! Linear DNGs in lossless JPEG tiles (Apple ProRAW), developed by
//! heeler-raw itself a tile at a time, the same to the bit as LibRaw's
//! develop of the whole file.
//!
//! LibRaw develops a frame whole: it loads every tile into an image of
//! four 16-bit channels a pixel, then scales, blends highlights and
//! converts it in place, which at 48 MP is about 14 bytes a pixel held
//! before a single row reaches the caller. A ProRAW is already
//! demosaiced, so each output pixel depends on its own source pixel
//! only, apart from two numbers the whole frame decides: the brightest
//! sample (LibRaw's data_maximum, which can lower the white level) and,
//! for a Blend develop, whether enough of the frame clipped. This module
//! keeps the file's bytes and makes any rows from the tiles under them,
//! with LibRaw's own numbers: the sizes, levels, white balance and
//! matrix LibRaw read when it opened the file (heeler_linear_facts in
//! the shim), its linearization table and its output curve, and its
//! arithmetic step for step (raw2image_ex, subtract_black_internal,
//! adjust_maximum, scale_colors, blend_highlights, convert_to_rgb and
//! copy_mem_image, for the case these files are). Anything outside that
//! case is declined (LinearDng::open answers None) and LibRaw develops
//! it as before.

use std::ffi::{c_int, c_void};

use crate::{check, configured, DevelopOpts, Handle, RawError};

#[repr(C)]
#[derive(Clone, Copy)]
#[doc(hidden)]
pub struct Facts {
    pub raw_width: u32,
    pub raw_height: u32,
    pub width: u32,
    pub height: u32,
    pub top_margin: u32,
    pub left_margin: u32,
    pub flip: c_int,
    pub filters: u32,
    pub colors: c_int,
    pub tiff_samples: u32,
    pub tiff_bps: u32,
    pub tiff_compress: u32,
    pub tile_width: u32,
    pub tile_length: u32,
    pub raw_color: u32,
    pub zero_is_bad: u32,
    pub fuji_width: u32,
    pub is_foveon: u32,
    pub lossless_dng: u32,
    pub maximum: u32,
    pub black: u32,
    pub cblack: [u32; 6],
    pub dng_version: u32,
    pub as_shot_wb_applied: c_int,
    pub pixel_aspect: f32,
    pub cam_mul: [f32; 4],
    pub pre_mul: [f32; 4],
    pub rgb_cam: [[f32; 4]; 3],
    pub white: [[u16; 8]; 8],
    pub user_mul: [f32; 4],
    pub use_auto_wb: c_int,
    pub use_camera_wb: c_int,
    pub highlight: c_int,
    pub user_black: c_int,
    pub user_cblack: [c_int; 4],
    pub user_sat: c_int,
    pub med_passes: c_int,
    pub no_auto_scale: c_int,
    pub green_matching: c_int,
    pub exp_correc: c_int,
    pub no_interpolation: c_int,
    pub has_bad_pixels: c_int,
    pub has_dark_frame: c_int,
    pub cropbox_set: c_int,
    pub half_size: c_int,
    pub output_color: c_int,
    pub output_bps: c_int,
    pub four_color_rgb: c_int,
    pub use_fuji_rotate: c_int,
    pub threshold: f32,
    pub adjust_maximum_thr: f32,
    pub bright: f32,
    pub aber: [f64; 4],
    pub gamm: [f64; 6],
}

extern "C" {
    fn heeler_linear_facts(d: *mut c_void, f: *mut Facts, lintable: *mut u16, outcurve: *mut u16) -> c_int;
    fn heeler_opcode_list3(d: *mut c_void, len: *mut usize) -> *const u8;
    fn heeler_linear_capture(d: *mut c_void, loaded: *mut u16, scaled: *mut u16, before_rgb: *mut u16, pixels: usize, maxima: *mut u32, pre_mul: *mut f32, rgb_cam: *mut f32);
    fn libraw_open_buffer(d: *mut c_void, buf: *const c_void, size: usize) -> c_int;
    fn libraw_unpack(d: *mut c_void) -> c_int;
    fn libraw_dcraw_process(d: *mut c_void) -> c_int;
}

/// LibRaw's default for adjust_maximum_thr past 0.99999.
const DEFAULT_ADJUST_MAXIMUM_THRESHOLD: f32 = 0.75;

/// Why a file is not this module's to develop, for the tests; None when
/// it is.
fn declined(f: &Facts, opcode3: bool) -> Option<&'static str> {
    let reason = if f.filters != 0 || f.colors != 3 || f.tiff_samples != 3 {
        "not a three-sample linear raw"
    } else if f.lossless_dng == 0 || f.tiff_compress != 7 {
        "not lossless JPEG"
    } else if f.tile_width == 0 || f.tile_length == 0 || f.tile_length == u32::MAX || f.tile_width > f.raw_width {
        "not tiled"
    } else if f.width != f.raw_width || f.height != f.raw_height || f.top_margin != 0 || f.left_margin != 0 {
        "margins or a crop"
    } else if f.black != 0 || f.cblack.iter().any(|&b| b != 0) {
        "a black level"
    } else if f.raw_color != 0 || f.zero_is_bad != 0 || f.fuji_width != 0 || f.is_foveon != 0 {
        "a raw-color, zero-is-bad, SuperCCD or Foveon file"
    } else if f.pixel_aspect != 1.0 || f.as_shot_wb_applied != 0 {
        "non-square pixels or white balance already applied"
    } else if opcode3 {
        "an OpcodeList3"
    } else if f.user_mul.iter().any(|&m| m != 0.0) || f.use_auto_wb != 0 || f.user_black >= 0 || f.user_cblack.iter().any(|&b| b > -1_000_000) || f.user_sat > 0 {
        "user levels or white balance"
    } else if f.med_passes > 0 || f.no_auto_scale != 0 || f.green_matching != 0 || f.exp_correc > 0 || f.no_interpolation != 0 {
        "a median, exposure correction or no scaling"
    } else if f.has_bad_pixels != 0 || f.has_dark_frame != 0 || f.cropbox_set != 0 || f.half_size != 0 || f.four_color_rgb != 0 {
        "bad pixels, a dark frame, a crop box, half size or four-color RGB"
    } else if f.output_color != 1 || f.output_bps != 16 || f.threshold != 0.0 || f.aber[0] != 1.0 || f.aber[2] != 1.0 {
        "another output, denoising or aberration"
    } else if !(f.highlight == 0 || f.highlight == 2) {
        "a highlight rebuild"
    } else if f.use_camera_wb == 0 || f.cam_mul[0] <= 0.00001 || f.cam_mul[2] <= 0.00001 {
        "no camera white balance"
    } else if f.flip & !7 != 0 {
        "an unknown orientation"
    } else {
        return None;
    };
    Some(reason)
}

static ENABLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Whether callers take this module's develop where it applies (true, the
/// default) or LibRaw's for every file: for the tests that compare them.
pub fn enabled() -> bool {
    ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Turns this module's develop off (LibRaw's for every file) or on.
pub fn set_enabled(on: bool) {
    ENABLED.store(on, std::sync::atomic::Ordering::Relaxed);
}

/// A linear DNG ready to develop rows on demand.
pub struct LinearDng {
    bytes: Vec<u8>,
    facts: Facts,
    /// Every tile's start and length in `bytes`, row by row.
    tiles: Vec<(usize, usize)>,
    across: usize,
    lintable: Box<[u16]>,
    outcurve: Box<[u16]>,
    /// The tiles decoded last, newest last: a band reads the tiles under
    /// it, and the next band most of the same ones.
    cache: std::sync::Mutex<Vec<(usize, std::sync::Arc<Vec<u16>>)>>,
}

impl LinearDng {
    /// The file as this module develops it, or None when it is not one
    /// (LibRaw develops it then). `opts` are the develop's.
    pub fn open(bytes: Vec<u8>, opts: DevelopOpts) -> Result<Option<LinearDng>, RawError> {
        let Some((facts, lintable, outcurve)) = read_facts(&bytes, opts)? else { return Ok(None) };
        let Some(tiles) = tile_table(&bytes, &facts) else { return Ok(None) };
        let across = (facts.raw_width as usize).div_ceil(facts.tile_width as usize);
        Ok(Some(LinearDng { bytes, facts, tiles, across, lintable, outcurve, cache: std::sync::Mutex::new(Vec::new()) }))
    }

    /// The frame's size as LibRaw hands it back (turned when the file
    /// says so).
    pub fn size(&self) -> (usize, usize) {
        let (w, h) = (self.facts.width as usize, self.facts.height as usize);
        if self.facts.flip & 4 != 0 { (h, w) } else { (w, h) }
    }

    /// The bytes it keeps, for admission: the file, its tables, and the
    /// tile cache at its fullest.
    pub fn bytes(&self) -> usize {
        let tile = (self.facts.tile_width as usize).saturating_mul(self.facts.tile_length as usize).saturating_mul(6);
        self.bytes.capacity()
            .saturating_add(self.tiles.capacity().saturating_mul(16))
            .saturating_add((self.lintable.len() + self.outcurve.len()) * 2)
            .saturating_add(self.cache_tiles().saturating_mul(tile.saturating_add(80)))
            .saturating_add(1024)
    }

    /// Peak workspace beside the kept file and cache: one tile and its
    /// developed pixels per active worker, JPEG tables and predictor
    /// rows, and the tile index lists. Output samples are counted by the
    /// caller separately.
    pub fn workspace(&self) -> Result<usize, heeler_engine::memory::MemoryError> {
        use heeler_engine::memory::{bytes, sum};
        let workers = rayon::current_num_threads().min(self.tiles.len());
        let tile = bytes(self.facts.tile_width as usize, self.facts.tile_length as usize, 1, 22)?;
        let decoder = 9 * (1 + (1 << 16)) * 2 + 65535 * 12 + 4096;
        sum([bytes(workers, 1, 1, sum([tile, decoder])?)?, bytes(self.tiles.len(), 1, 1, 32)?, 4096])
    }

    /// How many decoded tiles the cache holds: one row or column of tiles,
    /// whichever a band of the output runs along. A band no taller than a
    /// tile spans two at most, and the next band reads the newer one.
    fn cache_tiles(&self) -> usize {
        let down = self.tiles.len() / self.across.max(1);
        if self.facts.flip & 4 != 0 { down } else { self.across }
    }

    /// Tile `t`, from the cache or decoded into it.
    fn cached(&self, t: usize) -> Result<std::sync::Arc<Vec<u16>>, RawError> {
        if let Some(hit) = self.cache.lock().unwrap_or_else(|e| e.into_inner()).iter().find(|(i, _)| *i == t).map(|(_, v)| v.clone()) {
            return Ok(hit);
        }
        let tile = std::sync::Arc::new(self.decode_tile(t)?);
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.retain(|(i, _)| *i != t);
        cache.push((t, tile.clone()));
        let keep = self.cache_tiles();
        if cache.len() > keep {
            let drop = cache.len() - keep;
            cache.drain(..drop);
        }
        Ok(tile)
    }

    /// One source pixel developed with `n`: scale_colors, the highlights,
    /// convert_to_rgb and copy_mem_image's curve.
    #[inline]
    fn develop(&self, n: &Numbers, px: &[u16]) -> [u16; 3] {
        let s = [scale(px[0], n.scale_mul[0]), scale(px[1], n.scale_mul[1]), scale(px[2], n.scale_mul[2])];
        let b = if n.highlight == 2 { blend(s, n.clip, true) } else { s };
        convert(b, &n.out_cam, true).map(|v| self.outcurve[v as usize])
    }

    /// The develop's output rows `y0..y1` with `n`, three 16-bit samples a
    /// pixel, in the orientation copy_mem_image writes: what LibRaw's
    /// develop of the whole frame hands back for those rows, to the bit.
    pub fn rows(&self, n: &Numbers, y0: usize, y1: usize) -> Result<Vec<u16>, RawError> {
        use rayon::prelude::*;
        let (ow, oh) = self.size();
        if y0 > y1 || y1 > oh { return Err(RawError::Unexpected) }
        if y0 == y1 { return Ok(Vec::new()) }
        let output = heeler_engine::memory::bytes(ow, y1 - y0, 3, 2)?;
        let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([self.bytes(), self.workspace()?, output])?, "linear DNG rows")?;
        let (sw, sh) = (self.facts.width as usize, self.facts.height as usize);
        let flip = self.facts.flip;
        let (tw, th) = (self.facts.tile_width as usize, self.facts.tile_length as usize);
        // The source rectangle under the output rows.
        let mirror = |v: usize, len: usize, on: bool| if on { len - 1 - v } else { v };
        let (rows, cols) = if flip & 4 != 0 {
            let (a, b) = (mirror(y0, sw, flip & 1 != 0), mirror(y1 - 1, sw, flip & 1 != 0));
            ((0, sh), (a.min(b), a.max(b) + 1))
        } else {
            let (a, b) = (mirror(y0, sh, flip & 2 != 0), mirror(y1 - 1, sh, flip & 2 != 0));
            ((a.min(b), a.max(b) + 1), (0, sw))
        };
        let tiles: Vec<usize> = (rows.0 / th..rows.1.div_ceil(th))
            .flat_map(|tr| (cols.0 / tw..cols.1.div_ceil(tw)).map(move |tc| tr * self.across + tc))
            .collect();
        let mut out = vec![0u16; ow * (y1 - y0) * 3];
        let band = std::sync::Mutex::new(&mut out);
        tiles.par_iter().try_for_each(|&t| -> Result<(), RawError> {
            let tile = self.cached(t)?;
            let (r0, c0) = ((t / self.across) * th, (t % self.across) * tw);
            let height = (r0 + th).min(rows.1) - r0.max(rows.0);
            let width = (c0 + tw).min(cols.1) - c0.max(cols.0);
            let mut local = Vec::with_capacity(width * height);
            for r in r0.max(rows.0)..(r0 + th).min(rows.1) {
                for c in c0.max(cols.0)..(c0 + tw).min(cols.1) {
                    let i = ((r - r0) * tw + (c - c0)) * 3;
                    let (oy, ox) = self.to_output(r, c);
                    if oy < y0 || oy >= y1 {
                        continue;
                    }
                    local.push(((oy - y0) * ow + ox, self.develop(n, &tile[i..i + 3])));
                }
            }
            let mut band = band.lock().unwrap_or_else(|e| e.into_inner());
            for (at, px) in local {
                band[at * 3..at * 3 + 3].copy_from_slice(&px);
            }
            Ok(())
        })?;
        Ok(out)
    }

    /// How many pixels of the develop with `n` reach `at_white` in any
    /// channel, over the whole frame.
    pub fn count_at_white(&self, n: &Numbers, at_white: u16) -> Result<usize, RawError> {
        let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([self.bytes(), self.workspace()?])?, "linear DNG highlights")?;
        use rayon::prelude::*;
        let (sw, sh) = (self.facts.width as usize, self.facts.height as usize);
        let (tw, th) = (self.facts.tile_width as usize, self.facts.tile_length as usize);
        let counts: Result<Vec<usize>, RawError> = (0..self.tiles.len()).into_par_iter().map(|t| {
            let tile = self.decode_tile(t)?;
            let (r0, c0) = ((t / self.across) * th, (t % self.across) * tw);
            let mut k = 0;
            for r in r0..(r0 + th).min(sh) {
                for c in c0..(c0 + tw).min(sw) {
                    let i = ((r - r0) * tw + (c - c0)) * 3;
                    let px = self.develop(n, &tile[i..i + 3]);
                    if px[0].max(px[1]).max(px[2]) >= at_white {
                        k += 1;
                    }
                }
            }
            Ok(k)
        }).collect();
        Ok(counts?.into_iter().sum())
    }

    /// Tile `t`'s samples as LibRaw loads them: through its linearization
    /// table, three a pixel, `tile_width` by `tile_length`, the parts
    /// past the frame's edge left zero.
    #[doc(hidden)]
    pub fn tile(&self, t: usize) -> Result<Vec<u16>, RawError> {
        let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([self.bytes(), self.workspace()?])?, "linear DNG tile")?;
        self.decode_tile(t)
    }

    fn decode_tile(&self, t: usize) -> Result<Vec<u16>, RawError> {
        let (tw, th) = (self.facts.tile_width as usize, self.facts.tile_length as usize);
        let &(at, len) = self.tiles.get(t).ok_or(RawError::Unexpected)?;
        let data = self.bytes.get(at..at + len).ok_or(RawError::Unexpected)?;
        let mut out = vec![0u16; tw * th * 3];
        let (trow, tcol) = ((t / self.across) * th, (t % self.across) * tw);
        let (rw, rh) = (self.facts.raw_width as usize, self.facts.raw_height as usize);
        let lin = &self.lintable;
        ljpeg::decode(data, |row, col, samples| {
            // adobe_copy_pixel: the frame's bounds, then the table.
            if trow + row < rh && tcol + col < rw && row < th {
                let o = (row * tw + col) * 3;
                for c in 0..3 {
                    out[o + c] = lin[samples[c] as usize];
                }
            }
        }, tw, rw)
        .map_err(|_| RawError::Unexpected)?;
        Ok(out)
    }

    #[doc(hidden)]
    pub fn tiles_count(&self) -> usize {
        self.tiles.len()
    }

    /// Where source pixel (y, x) lands in the output: copy_mem_image's
    /// flip_index, read the other way.
    #[doc(hidden)]
    pub fn to_output(&self, y: usize, x: usize) -> (usize, usize) {
        let (h, w) = (self.facts.height as usize, self.facts.width as usize);
        let flip = self.facts.flip;
        let row = if flip & 2 != 0 { h - 1 - y } else { y };
        let col = if flip & 1 != 0 { w - 1 - x } else { x };
        if flip & 4 != 0 { (col, row) } else { (row, col) }
    }

    #[doc(hidden)]
    pub fn flip(&self) -> i32 {
        self.facts.flip
    }

    /// copy_mem_image's output curve.
    #[doc(hidden)]
    pub fn curve(&self, v: u16) -> u16 {
        self.outcurve[v as usize]
    }

    #[doc(hidden)]
    pub fn tile_size(&self) -> (usize, usize, usize) {
        (self.facts.tile_width as usize, self.facts.tile_length as usize, self.across)
    }
}

/// The numbers a develop applies to every pixel, settled once for the
/// frame as dcraw_process settles them.
#[derive(Clone, Copy, Debug)]
pub struct Numbers {
    /// The white level after adjust_maximum.
    pub maximum: u32,
    /// scale_colors' multipliers.
    pub scale_mul: [f32; 4],
    /// pre_mul as scale_colors leaves it (divided by its largest, or its
    /// smallest without a highlight mode).
    pub pre_mul: [f32; 4],
    /// blend_highlights' clip level.
    pub clip: i32,
    /// convert_to_rgb's matrix.
    pub out_cam: [[f32; 4]; 3],
    pub highlight: i32,
}

impl LinearDng {
    /// The brightest sample of the frame, LibRaw's data_maximum: the
    /// fourth channel it never loads is zero, so the three loaded.
    pub fn data_maximum(&self) -> Result<u16, RawError> {
        let _job = heeler_engine::memory::Job::admit(heeler_engine::memory::sum([self.bytes(), self.workspace()?])?, "linear DNG maximum")?;
        use rayon::prelude::*;
        let maxima: Result<Vec<u16>, RawError> = (0..self.tiles.len()).into_par_iter().map(|t| Ok(self.decode_tile(t)?.into_iter().max().unwrap_or(0))).collect();
        Ok(maxima?.into_iter().max().unwrap_or(0))
    }

    /// The develop's numbers for `highlight` (0 clip, 2 blend) given the
    /// frame's data maximum: adjust_maximum, then scale_colors' white
    /// balance (the camera's, which is what this module develops: the
    /// 8 by 8 white table of a linear file has one color, so its sums
    /// fall through to cam_mul), then convert_to_rgb's matrix for sRGB.
    pub fn numbers(&self, data_maximum: u16, highlight: i32) -> Numbers {
        let f = &self.facts;
        let mut maximum = f.maximum;
        if f.adjust_maximum_thr >= 0.00001 {
            let threshold = if f.adjust_maximum_thr > 0.99999 { DEFAULT_ADJUST_MAXIMUM_THRESHOLD } else { f.adjust_maximum_thr };
            let real_max = data_maximum;
            if real_max > 0 && (real_max as u32) < maximum && (real_max as f32) > maximum as f32 * threshold {
                maximum = real_max as u32;
            }
        }
        // scale_colors with the camera's white balance.
        let mut pre_mul = f.cam_mul;
        let mut sums = [0u32; 8];
        for row in 0..8 {
            for col in 0..8 {
                // FC(row, col) of a linear file (filters 0) is color 0.
                let v = f.white[row][col] as i64 - f.cblack[0] as i64;
                if v > 0 {
                    sums[0] = sums[0].wrapping_add(v as u32);
                }
                sums[4] += 1;
            }
            let _ = row;
        }
        if sums[0] != 0 && sums[1] != 0 && sums[2] != 0 && sums[3] != 0 {
            for c in 0..4 {
                pre_mul[c] = sums[c + 4] as f32 / sums[c] as f32;
            }
        }
        if pre_mul[1] == 0.0 {
            pre_mul[1] = 1.0;
        }
        if pre_mul[3] == 0.0 {
            pre_mul[3] = if f.colors < 4 { pre_mul[1] } else { 1.0 };
        }
        let (mut dmin, mut dmax) = (f64::MAX, 0.0f64);
        for &p in &pre_mul {
            if dmin > p as f64 {
                dmin = p as f64;
            }
            if dmax < p as f64 {
                dmax = p as f64;
            }
        }
        if highlight == 0 {
            dmax = dmin;
        }
        let mut scale_mul = [1.0f32; 4];
        if dmax > 0.00001 && maximum > 0 {
            for c in 0..4 {
                pre_mul[c] /= dmax as f32;
                scale_mul[c] = pre_mul[c] * 65535.0f32 / maximum as f32;
            }
        }
        let mut clip = i32::MAX;
        for &p in &pre_mul[..3] {
            let i = (65535.0f32 * p) as i32;
            if clip > i {
                clip = i;
            }
        }
        // convert_to_rgb for sRGB: LibRaw's rgb_rgb is the identity, and
        // out_cam[i][j] sums float(rgb_rgb[i][k] * rgb_cam[k][j]) over k.
        let mut out_cam = f.rgb_cam;
        for i in 0..3 {
            for j in 0..3 {
                let mut acc = 0.0f32;
                for k in 0..3 {
                    let m = if i == k { 1.0f64 } else { 0.0 };
                    acc += (m * f.rgb_cam[k][j] as f64) as f32;
                }
                out_cam[i][j] = acc;
            }
        }
        Numbers { maximum, scale_mul, pre_mul, clip, out_cam, highlight }
    }

    /// The white balance's headroom, heeler_wb_headroom's: the largest of
    /// the scaled pre_mul over the smallest.
    pub fn headroom(n: &Numbers) -> f32 {
        let (mut mn, mut mx) = (0.0f32, 0.0f32);
        for &v in &n.pre_mul {
            if v <= 0.0 {
                continue;
            }
            if mn == 0.0 || v < mn {
                mn = v;
            }
            if v > mx {
                mx = v;
            }
        }
        if mn <= 0.0 || mx <= 0.0 { 1.0 } else { mx / mn }
    }
}

/// scale_colors_loop's black-free branch for one sample.
#[inline]
pub fn scale(v: u16, mul: f32) -> u16 {
    ((v as f32 * mul) as i32).clamp(0, 65535) as u16
}

/// blend_highlights for one pixel of three colors.
#[doc(hidden)]
pub fn blend(px: [u16; 3], clip: i32, fused: bool) -> [u16; 3] {
    const TRANS: [[f32; 3]; 3] = [[1.0, 1.0, 1.0], [1.7320508, -1.7320508, 0.0], [-1.0, -1.0, 2.0]];
    const ITRANS: [[f32; 3]; 3] = [[1.0, 0.8660254, -0.5], [1.0, -0.8660254, -0.5], [1.0, 0.0, 1.0]];
    if px.iter().all(|&v| v as i32 <= clip) {
        return px;
    }
    let mut cam = [[0.0f32; 3]; 2];
    for c in 0..3 {
        cam[0][c] = px[c] as f32;
        cam[1][c] = if cam[0][c] < clip as f32 { cam[0][c] } else { clip as f32 };
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
        // clang fuses SQR(lab) into the sum, and each itrans product into
        // the next one's multiply-add below (found against LibRaw on the
        // files' blended pixels).
        sum[i] = 0.0;
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
            acc = if fused || j > 0 { ITRANS[c][j].mul_add(lab[0][j], acc) } else { acc + ITRANS[c][j] * lab[0][j] };
        }
        out[c] = ((acc / 3.0) as u32) as u16;
    }
    out
}

/// convert_to_rgb_loop for one pixel of three colors.
#[doc(hidden)]
pub fn convert(px: [u16; 3], oc: &[[f32; 4]; 3], fused: bool) -> [u16; 3] {
    let mut out = [0u16; 3];
    for i in 0..3 {
        let (a, b, c) = (px[0] as f32, px[1] as f32, px[2] as f32);
        // The order LibRaw's build evaluates out_cam[i][0] * img[0] +
        // out_cam[i][1] * img[1] + out_cam[i][2] * img[2] in: clang fuses
        // the first product into the second's multiply-add and that into
        // the third's (found against LibRaw on the files: every other
        // order and fusing differs on some samples).
        let v = if fused { oc[i][2].mul_add(c, oc[i][0].mul_add(a, oc[i][1] * b)) } else { oc[i][0] * a + oc[i][1] * b + oc[i][2] * c };
        out[i] = (v as i32).clamp(0, 65535) as u16;
    }
    out
}

/// LibRaw's facts about `bytes` and its two tables, or None when the
/// file is not this module's.
fn read_facts(bytes: &[u8], opts: DevelopOpts) -> Result<Option<(Facts, Box<[u16]>, Box<[u16]>)>, RawError> {
    let handle: Handle = configured(opts)?;
    if check(unsafe { libraw_open_buffer(handle.0, bytes.as_ptr() as *const c_void, bytes.len()) }).is_err() {
        return Ok(None);
    }
    let mut facts = std::mem::MaybeUninit::<Facts>::zeroed();
    let mut lintable = vec![0u16; 0x10000].into_boxed_slice();
    let mut outcurve = vec![0u16; 0x10000].into_boxed_slice();
    if unsafe { heeler_linear_facts(handle.0, facts.as_mut_ptr(), lintable.as_mut_ptr(), outcurve.as_mut_ptr()) } == 0 {
        return Ok(None);
    }
    let facts = unsafe { facts.assume_init() };
    let mut len = 0usize;
    let opcode3 = !unsafe { heeler_opcode_list3(handle.0, &mut len) }.is_null() && len > 0;
    if declined(&facts, opcode3).is_some() {
        return Ok(None);
    }
    Ok(Some((facts, lintable, outcurve)))
}

/// Why LibRaw's facts about `bytes` keep it from this module, None when
/// they do not: for the tests.
#[doc(hidden)]
pub fn declined_because(bytes: &[u8], opts: DevelopOpts) -> Result<Option<&'static str>, RawError> {
    let handle: Handle = configured(opts)?;
    check(unsafe { libraw_open_buffer(handle.0, bytes.as_ptr() as *const c_void, bytes.len()) })?;
    let mut facts = std::mem::MaybeUninit::<Facts>::zeroed();
    if unsafe { heeler_linear_facts(handle.0, facts.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut()) } == 0 {
        return Ok(Some("not open"));
    }
    let facts = unsafe { facts.assume_init() };
    let mut len = 0usize;
    let opcode3 = !unsafe { heeler_opcode_list3(handle.0, &mut len) }.is_null() && len > 0;
    Ok(declined(&facts, opcode3))
}

/// What LibRaw read when it opened `bytes` with `opts`: its sizes,
/// levels, white balance and matrix, before unpacking. For the tests
/// and harnesses that hold heeler-rawdec to LibRaw.
#[doc(hidden)]
pub fn libraw_facts(bytes: &[u8], opts: DevelopOpts) -> Result<Facts, RawError> {
    let handle: Handle = configured(opts)?;
    check(unsafe { libraw_open_buffer(handle.0, bytes.as_ptr() as *const c_void, bytes.len()) })?;
    let mut facts = std::mem::MaybeUninit::<Facts>::zeroed();
    if unsafe { heeler_linear_facts(handle.0, facts.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut()) } == 0 {
        return Err(RawError::Unexpected);
    }
    Ok(unsafe { facts.assume_init() })
}

/// The raw image's tiles, row by row, from the file's own directory: the
/// one directory with the frame's size, LinearRaw and lossless JPEG.
fn tile_table(bytes: &[u8], f: &Facts) -> Option<Vec<(usize, usize)>> {
    let tiff = tiff::Tiff::new(bytes)?;
    for ifd in tiff.ifds() {
        let get = |tag: u16| ifd.get(tag).and_then(|e| tiff.values(&e));
        let one = |tag: u16| get(tag).and_then(|v| v.first().copied());
        if one(262) != Some(34892) || one(259) != Some(7) || one(256) != Some(f.raw_width as u64) || one(257) != Some(f.raw_height as u64) {
            continue;
        }
        if one(322) != Some(f.tile_width as u64) || one(323) != Some(f.tile_length as u64) {
            return None;
        }
        let offsets = get(324)?;
        let counts = get(325)?;
        let across = (f.raw_width as usize).div_ceil(f.tile_width as usize);
        let down = (f.raw_height as usize).div_ceil(f.tile_length as usize);
        if offsets.len() != across * down || counts.len() != offsets.len() {
            return None;
        }
        let tiles: Vec<(usize, usize)> = offsets.iter().zip(&counts).map(|(&o, &n)| (o as usize, n as usize)).collect();
        if tiles.iter().any(|&(o, n)| o.checked_add(n).is_none_or(|end| end > bytes.len())) {
            return None;
        }
        return Some(tiles);
    }
    None
}

/// What LibRaw's develop of `bytes` holds at three points, for the tests
/// that hold this module to it step by step.
#[doc(hidden)]
pub struct Stages {
    pub width: usize,
    pub height: usize,
    /// Four channels a pixel, as loaded (black level zero, so also as
    /// subtract_black_internal leaves it).
    pub loaded: Vec<u16>,
    /// After scale_colors.
    pub scaled: Vec<u16>,
    /// After the highlights, before convert_to_rgb.
    pub before_rgb: Vec<u16>,
    /// The white level and data maximum before the scale, and the white
    /// level after it.
    pub maxima: [u32; 3],
    /// pre_mul after the scale normalized it.
    pub pre_mul: [f32; 4],
    /// rgb_cam as convert_to_rgb finds it.
    pub rgb_cam: [[f32; 4]; 3],
}

#[doc(hidden)]
pub fn libraw_stages(bytes: &[u8], opts: DevelopOpts) -> Result<Stages, RawError> {
    let handle: Handle = configured(opts)?;
    check(unsafe { libraw_open_buffer(handle.0, bytes.as_ptr() as *const c_void, bytes.len()) })?;
    let mut facts = std::mem::MaybeUninit::<Facts>::zeroed();
    unsafe { heeler_linear_facts(handle.0, facts.as_mut_ptr(), std::ptr::null_mut(), std::ptr::null_mut()) };
    let facts = unsafe { facts.assume_init() };
    let (width, height) = (facts.width as usize, facts.height as usize);
    let n = width * height;
    let mut s = Stages { width, height, loaded: vec![0; n * 4], scaled: vec![0; n * 4], before_rgb: vec![0; n * 4], maxima: [0; 3], pre_mul: [0.0; 4], rgb_cam: [[0.0; 4]; 3] };
    check(unsafe { libraw_unpack(handle.0) })?;
    unsafe { heeler_linear_capture(handle.0, s.loaded.as_mut_ptr(), s.scaled.as_mut_ptr(), s.before_rgb.as_mut_ptr(), n, s.maxima.as_mut_ptr(), s.pre_mul.as_mut_ptr(), s.rgb_cam.as_mut_ptr() as *mut f32) };
    check(unsafe { libraw_dcraw_process(handle.0) })?;
    Ok(s)
}

/// Lossless JPEG (ITU T.81 process 14) as LibRaw's ljpeg_start and
/// ljpeg_row read it: its bit reader, Huffman tables, first-column and
/// row predictors and overflow, sample for sample.
mod ljpeg {
    pub struct Bad;

    struct Bits<'a> {
        data: &'a [u8],
        at: usize,
        buf: u32,
        vbits: i32,
        reset: bool,
    }

    impl Bits<'_> {
        fn clear(&mut self) {
            self.buf = 0;
            self.vbits = 0;
            self.reset = false;
        }
        /// LibRaw's getbithuff: `n` bits, or a Huffman symbol through
        /// `huff` (whose first entry is its longest code length).
        fn get(&mut self, n: i32, huff: Option<&[u16]>) -> Result<u32, Bad> {
            if !(0..=16).contains(&n) {
                return Err(Bad);
            }
            if n == 0 {
                return if huff.is_none() { Ok(0) } else { Err(Bad) };
            }
            while !self.reset && self.vbits < n {
                let Some(&c) = self.data.get(self.at) else { break };
                self.at += 1;
                if c == 0xff {
                    let next = self.data.get(self.at).copied();
                    self.at += 1;
                    if next != Some(0) {
                        self.reset = true;
                        break;
                    }
                }
                self.buf = (self.buf << 8).wrapping_add(c as u32);
                self.vbits += 8;
            }
            // A Huffman lookup can peek past the last sample's bits, but
            // its actual code and every difference must be present.
            let c = if self.vbits == 0 { 0 } else { (self.buf << (32 - self.vbits) as u32) >> (32 - n) as u32 };
            let (used, value) = match huff {
                Some(h) => {
                    let e = *h.get(1 + c as usize).ok_or(Bad)?;
                    let used = (e >> 8) as i32;
                    if used == 0 { return Err(Bad) }
                    (used, (e & 0xff) as u32)
                }
                None => (n, c),
            };
            if used > self.vbits { return Err(Bad) }
            self.vbits -= used;
            Ok(value)
        }
    }

    /// LibRaw's make_decoder_ref: a table of 1 + 2^max entries, the
    /// first the longest code length.
    fn decoder(spec: &[u8]) -> Option<(Vec<u16>, usize)> {
        let count = spec.get(..16)?;
        let mut max = 16;
        while max > 0 && count[max - 1] == 0 {
            max -= 1;
        }
        if max == 0 { return None }
        let mut huff = vec![0u16; 1 + (1 << max)];
        huff[0] = max as u16;
        let mut src = 16;
        let mut h = 1usize;
        for len in 1..=max {
            for _ in 0..count[len - 1] {
                let sym = *spec.get(src)? as u16;
                if sym > 16 { return None }
                src += 1;
                for _ in 0..1usize << (max - len) {
                    if h > 1 << max { return None }
                    huff[h] = (len as u16) << 8 | sym;
                    h += 1;
                }
            }
        }
        Some((huff, src))
    }

    /// Decodes a tile's lossless JPEG, handing each pixel's samples to
    /// `put` at the tile row and column LibRaw's lossless_dng_load_raw
    /// gives it (the samples run on, `tile_width` to a row, as its
    /// adobe_copy_pixel loop counts them).
    pub fn decode(data: &[u8], mut put: impl FnMut(usize, usize, &[u16]), tile_width: usize, raw_width: usize) -> Result<(), Bad> {
        if data.len() < 2 || data[0] != 0xff || data[1] != 0xd8 {
            return Err(Bad);
        }
        let mut at = 2usize;
        let (mut bits, mut high, mut wide, mut clrs, mut algo) = (0i32, 0usize, 0usize, 0usize, 0u8);
        let psv: i32;
        let mut restart = i64::MAX;
        let mut huff: [Option<std::rc::Rc<Vec<u16>>>; 20] = Default::default();
        loop {
            let seg = data.get(at..at + 4).ok_or(Bad)?;
            let tag = (seg[0] as u16) << 8 | seg[1] as u16;
            let len = ((seg[2] as u16) << 8 | seg[3] as u16).checked_sub(2).ok_or(Bad)? as usize;
            if tag <= 0xff00 {
                return Err(Bad);
            }
            let body = data.get(at + 4..at + 4 + len).ok_or(Bad)?;
            at += 4 + len;
            match tag {
                0xffc3 | 0xffc1 | 0xffc0 => {
                    if body.len() < 6 || body[5] != 3 || body.len() < 6 + 3 * body[5] as usize { return Err(Bad) }
                    let sraw = if tag == 0xffc3 { ((body[7] >> 4) as i32 * (body[7] & 15) as i32 - 1) & 3 } else { 0 };
                    if sraw != 0 {
                        // Canon sRAW subsampling, which a DNG never has.
                        return Err(Bad);
                    }
                    algo = (tag & 0xff) as u8;
                    bits = body[0] as i32;
                    high = (body[1] as usize) << 8 | body[2] as usize;
                    wide = (body[3] as usize) << 8 | body[4] as usize;
                    clrs = body[5] as usize;
                }
                0xffc4 => {
                    let mut dp = 0usize;
                    while dp < len {
                        let c = body[dp] as usize;
                        dp += 1;
                        if c & !19 != 0 {
                            return Err(Bad);
                        }
                        let (table, used) = decoder(&body[dp..]).ok_or(Bad)?;
                        huff[c] = Some(std::rc::Rc::new(table));
                        dp += used;
                    }
                }
                0xffda => {
                    let n = *body.first().ok_or(Bad)? as usize;
                    if n != clrs || body.len() < 4 + n * 2 { return Err(Bad) }
                    psv = *body.get(1 + n * 2).ok_or(Bad)? as i32;
                    bits -= (*body.get(3 + n * 2).ok_or(Bad)? & 15) as i32;
                    break;
                }
                0xffdd => {
                    if body.len() != 2 { return Err(Bad) }
                    restart = ((body[0] as i64) << 8) | body[1] as i64;
                }
                _ => {}
            }
        }
        if algo != 0xc3 || bits > 16 || clrs != 3 || bits <= 0 || high == 0 || wide == 0 {
            return Err(Bad);
        }
        let h0 = huff[0].clone().ok_or(Bad)?;
        let mut tables: Vec<std::rc::Rc<Vec<u16>>> = vec![h0];
        for c in 1..20 {
            let t = huff[c].clone().unwrap_or_else(|| tables[c - 1].clone());
            tables.push(t);
        }
        let mut b = Bits { data, at, buf: 0, vbits: 0, reset: false };
        let mut vpred = [0i32; 6];
        let mut rows = [vec![0u16; wide * clrs], vec![0u16; wide * clrs]];
        let diff = |b: &mut Bits, t: &[u16]| -> Result<i32, Bad> {
            let len = b.get(t[0] as i32, Some(t))? as i32;
            if len == 16 {
                return Ok(-32768);
            }
            let mut d = b.get(len, None)? as i32;
            if len > 0 && d & (1 << (len - 1)) == 0 {
                d -= (1 << len) - 1;
            }
            Ok(d)
        };
        let (mut row, mut col) = (0usize, 0usize);
        for jrow in 0..high {
            if restart != 0 && (jrow as i64 * wide as i64) % restart == 0 {
                vpred = [1 << (bits - 1); 6];
                if jrow > 0 {
                    // Back two bytes and on to the next RSTn marker.
                    let mut i = b.at.saturating_sub(2);
                    let mut mark: u16 = 0;
                    loop {
                        let &c = data.get(i).ok_or(Bad)?;
                        i += 1;
                        mark = (mark << 8).wrapping_add(c as u16);
                        if mark >> 4 == 0xffd {
                            break;
                        }
                    }
                    b.at = i;
                }
                b.clear();
            }
            let (cur, prev) = if jrow & 1 == 0 { let (a, p) = rows.split_at_mut(1); (&mut a[0], &p[0]) } else { let (p, a) = rows.split_at_mut(1); (&mut a[0], &p[0]) };
            for jc in 0..wide {
                for c in 0..clrs {
                    let d = diff(&mut b, &tables[c])?;
                    let i = jc * clrs + c;
                    let mut pred = if jc == 0 {
                        let p = vpred[c];
                        vpred[c] = vpred[c].checked_add(d).ok_or(Bad)?;
                        p
                    } else {
                        cur[i - clrs] as i32
                    };
                    if jrow > 0 && jc > 0 {
                        let (up, upleft) = (prev[i] as i32, prev[i - clrs] as i32);
                        pred = match psv {
                            1 => pred,
                            2 => up,
                            3 => upleft,
                            4 => pred + up - upleft,
                            5 => pred + ((up - upleft) >> 1),
                            6 => up + ((pred - upleft) >> 1),
                            7 => (pred + up) >> 1,
                            _ => 0,
                        };
                    }
                    let sample = pred.checked_add(d).ok_or(Bad)?;
                    // A 16-bit lossless difference can wrap, as LibRaw's
                    // assignment to ushort does.
                    cur[i] = sample as u16;
                }
            }
            for jc in 0..wide {
                put(row, col, &cur[jc * clrs..jc * clrs + 3]);
                col += 1;
                if col >= tile_width || col >= raw_width {
                    row += 1;
                    col = 0;
                }
            }
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        #[test]
        fn a_sixteen_bit_difference_wraps_as_libraws_ushort_does() {
            fn segment(out: &mut Vec<u8>, tag: u8, body: &[u8]) {
                out.extend_from_slice(&[255, tag]);
                out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
                out.extend_from_slice(body);
            }
            let mut data = vec![255, 216];
            segment(&mut data, 0xc3, &[16, 0, 1, 0, 2, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0]);
            let mut table = vec![0; 17];
            table[5] = 17;
            table.extend(0..17);
            segment(&mut data, 0xc4, &table);
            segment(&mut data, 0xda, &[3, 1, 0, 2, 0, 3, 0, 1, 0, 0]);
            let (mut acc, mut bits) = (0u64, 0u32);
            let mut put = |value: u32, n: u32| {
                acc = (acc << n) | value as u64;
                bits += n;
                while bits >= 8 {
                    let byte = (acc >> (bits - 8)) as u8;
                    data.push(byte);
                    if byte == 255 { data.push(0); }
                    bits -= 8;
                }
            };
            for (category, difference) in [(13, 7232), (15, 25536)] {
                for _ in 0..3 {
                    put(category, 5);
                    put(difference, category);
                }
            }
            if bits > 0 {
                let byte = ((acc << (8 - bits)) | ((1 << (8 - bits)) - 1)) as u8;
                data.push(byte);
                if byte == 255 { data.push(0); }
            }
            data.extend_from_slice(&[255, 217]);
            let mut pixels = Vec::new();
            assert!(super::decode(&data, |_, _, px| pixels.push(px.to_vec()), 2, 2).is_ok());
            assert_eq!(pixels, vec![vec![40000; 3], vec![0; 3]]);
        }
    }

}

/// The few TIFF reads tile_table needs.
mod tiff {
    pub struct Tiff<'a> {
        d: &'a [u8],
        le: bool,
    }
    #[derive(Clone, Copy)]
    pub struct Entry {
        typ: u16,
        count: u32,
        value: [u8; 4],
    }
    pub struct Ifd {
        entries: Vec<(u16, Entry)>,
    }
    impl Ifd {
        pub fn get(&self, tag: u16) -> Option<Entry> {
            self.entries.iter().find(|(t, _)| *t == tag).map(|(_, e)| *e)
        }
    }
    impl<'a> Tiff<'a> {
        pub fn new(d: &'a [u8]) -> Option<Self> {
            let le = match d.get(..2)? {
                b"II" => true,
                b"MM" => false,
                _ => return None,
            };
            Some(Tiff { d, le })
        }
        fn u16(&self, at: usize) -> Option<u16> {
            let b = self.d.get(at..at + 2)?;
            Some(if self.le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
        }
        fn u32(&self, at: usize) -> Option<u32> {
            let b = self.d.get(at..at + 4)?;
            let b = [b[0], b[1], b[2], b[3]];
            Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
        }
        fn ifd(&self, at: usize) -> Option<(Ifd, u32)> {
            let n = self.u16(at)? as usize;
            let mut entries = Vec::with_capacity(n);
            for i in 0..n {
                let e = at + 2 + i * 12;
                let value = self.d.get(e + 8..e + 12)?;
                entries.push((self.u16(e)?, Entry { typ: self.u16(e + 2)?, count: self.u32(e + 4)?, value: [value[0], value[1], value[2], value[3]] }));
            }
            Some((Ifd { entries }, self.u32(at + 2 + n * 12)?))
        }
        /// IFD0's chain and every SubIFD below them, a few levels deep.
        pub fn ifds(&self) -> Vec<Ifd> {
            let mut out = Vec::new();
            let mut todo: Vec<(u32, u32)> = self.u32(4).map(|o| vec![(o, 0)]).unwrap_or_default();
            let mut seen = std::collections::HashSet::new();
            while let Some((at, depth)) = todo.pop() {
                if at == 0 || depth > 4 || !seen.insert(at) || out.len() > 64 {
                    continue;
                }
                let Some((ifd, next)) = self.ifd(at as usize) else { continue };
                if let Some(e) = ifd.get(330) {
                    for o in self.values(&e).unwrap_or_default() {
                        todo.push((o as u32, depth + 1));
                    }
                }
                todo.push((next, depth));
                out.push(ifd);
            }
            out
        }
        /// An entry's SHORT or LONG values.
        pub fn values(&self, e: &Entry) -> Option<Vec<u64>> {
            let size = match e.typ {
                3 => 2,
                4 | 13 => 4,
                _ => return None,
            };
            let n = e.count as usize;
            let total = n.checked_mul(size)?;
            let base = if total <= 4 {
                None
            } else {
                let b = e.value;
                Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) } as usize)
            };
            if let Some(off) = base {
                self.d.get(off..off.checked_add(total)?)?;
            }
            let mut out = Vec::with_capacity(n);
            for i in 0..n {
                let v = match base {
                    None => {
                        let b = &e.value[i * size..i * size + size];
                        if size == 2 {
                            (if self.le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) }) as u64
                        } else {
                            (if self.le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) }) as u64
                        }
                    }
                    Some(off) => {
                        if size == 2 { self.u16(off + i * 2)? as u64 } else { self.u32(off + i * 4)? as u64 }
                    }
                };
                out.push(v);
            }
            Some(out)
        }
    }
}

/// A small linear DNG in lossless JPEG tiles, made here for the tests
/// that hold this module to LibRaw without a camera file: `w` by `h`,
/// tiles `tw` by `th`, 10-bit samples through a linearization table to
/// 16 bits, the camera's white balance and matrix, the TIFF orientation
/// `orientation`, and pixels from `pixel` (row, col) in 0..1024.
#[doc(hidden)]
pub fn synthetic_dng(w: usize, h: usize, tw: usize, th: usize, orientation: u16, pixel: impl Fn(usize, usize) -> [u16; 3]) -> Vec<u8> {
    const BITS: u8 = 10;
    // One Huffman table: the 17 difference categories, each five bits.
    fn ljpeg(tile: &[[u16; 3]], tw: usize, th: usize) -> Vec<u8> {
        let mut out = vec![0xff, 0xd8];
        let seg = |out: &mut Vec<u8>, tag: u8, body: &[u8]| {
            out.extend_from_slice(&[0xff, tag]);
            out.extend_from_slice(&((body.len() + 2) as u16).to_be_bytes());
            out.extend_from_slice(body);
        };
        let mut sof = vec![BITS];
        sof.extend_from_slice(&(th as u16).to_be_bytes());
        sof.extend_from_slice(&(tw as u16).to_be_bytes());
        sof.push(3);
        for c in 0..3u8 {
            sof.extend_from_slice(&[c + 1, 0x11, 0]);
        }
        seg(&mut out, 0xc3, &sof);
        let mut dht = vec![0x00];
        let mut counts = [0u8; 16];
        counts[4] = 17;
        dht.extend_from_slice(&counts);
        dht.extend((0..17u8).collect::<Vec<_>>());
        seg(&mut out, 0xc4, &dht);
        seg(&mut out, 0xda, &[3, 1, 0x00, 2, 0x00, 3, 0x00, 1, 0, 0]);
        struct Writer {
            acc: u64,
            nbits: u32,
            data: Vec<u8>,
        }
        impl Writer {
            fn put(&mut self, v: u32, n: u32) {
                self.acc = (self.acc << n) | (v as u64 & ((1u64 << n) - 1));
                self.nbits += n;
                while self.nbits >= 8 {
                    let byte = (self.acc >> (self.nbits - 8)) as u8;
                    self.data.push(byte);
                    if byte == 0xff {
                        self.data.push(0);
                    }
                    self.nbits -= 8;
                }
            }
        }
        let mut wr = Writer { acc: 0, nbits: 0, data: Vec::new() };
        let mut vpred = [1i32 << (BITS - 1); 3];
        for r in 0..th {
            for c in 0..tw {
                for k in 0..3 {
                    let v = tile[r * tw + c][k] as i32;
                    let pred = if c == 0 { let p = vpred[k]; vpred[k] = v; p } else { tile[r * tw + c - 1][k] as i32 };
                    let diff = v - pred;
                    let cat = 32 - (diff.unsigned_abs()).leading_zeros();
                    wr.put(cat, 5);
                    if cat > 0 {
                        let bits = if diff < 0 { (diff - 1) as u32 } else { diff as u32 };
                        wr.put(bits, cat);
                    }
                }
            }
        }
        if wr.nbits > 0 {
            let pad = 8 - wr.nbits;
            wr.put((1 << pad) - 1, pad);
        }
        let data = wr.data;
        out.extend_from_slice(&data);
        out.extend_from_slice(&[0xff, 0xd9]);
        out
    }
    let across = w.div_ceil(tw);
    let down = h.div_ceil(th);
    let mut tiles = Vec::new();
    for tr in 0..down {
        for tc in 0..across {
            let mut t = vec![[0u16; 3]; tw * th];
            for r in 0..th {
                for c in 0..tw {
                    let (y, x) = (tr * th + r, tc * tw + c);
                    if y < h && x < w {
                        t[r * tw + c] = pixel(y, x);
                    }
                }
            }
            tiles.push(ljpeg(&t, tw, th));
        }
    }
    // A linearization table from 10 bits to 16, slightly curved.
    let lin: Vec<u16> = (0..1024u32).map(|i| ((i as f64 / 1023.0).powf(1.08) * 65535.0).round() as u16).collect();
    // The TIFF: one IFD, the raw image.
    let mut entries: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
    let short = |v: &[u16]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let long = |v: &[u32]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let srational = |v: &[(i32, i32)]| v.iter().flat_map(|(a, b)| [a.to_le_bytes(), b.to_le_bytes()].concat()).collect::<Vec<u8>>();
    let rational = |v: &[(u32, u32)]| v.iter().flat_map(|(a, b)| [a.to_le_bytes(), b.to_le_bytes()].concat()).collect::<Vec<u8>>();
    entries.push((254, 4, 1, long(&[0])));
    entries.push((256, 4, 1, long(&[w as u32])));
    entries.push((257, 4, 1, long(&[h as u32])));
    entries.push((258, 3, 3, short(&[BITS as u16; 3])));
    entries.push((259, 3, 1, short(&[7])));
    entries.push((262, 3, 1, short(&[34892])));
    entries.push((271, 2, 6, b"Heeler".to_vec()));
    entries.push((272, 2, 5, b"Test\0".to_vec()));
    entries.push((274, 3, 1, short(&[orientation])));
    entries.push((277, 3, 1, short(&[3])));
    entries.push((284, 3, 1, short(&[1])));
    entries.push((322, 4, 1, long(&[tw as u32])));
    entries.push((323, 4, 1, long(&[th as u32])));
    entries.push((324, 4, tiles.len() as u32, vec![]));
    entries.push((325, 4, tiles.len() as u32, long(&tiles.iter().map(|t| t.len() as u32).collect::<Vec<_>>())));
    entries.push((50706, 1, 4, vec![1, 4, 0, 0]));
    entries.push((50708, 2, 12, b"Heeler Test\0".to_vec()));
    entries.push((50712, 3, lin.len() as u32, short(&lin)));
    entries.push((50714, 4, 1, long(&[0])));
    entries.push((50717, 4, 1, long(&[65535])));
    entries.push((50721, 10, 9, srational(&[(8360, 10000), (-2960, 10000), (-740, 10000), (-4130, 10000), (12080, 10000), (2290, 10000), (-860, 10000), (1960, 10000), (5970, 10000)])));
    entries.push((50728, 5, 3, rational(&[(480, 1000), (1000, 1000), (620, 1000)])));
    entries.push((50778, 3, 1, short(&[21])));
    entries.sort_by_key(|e| e.0);
    let n = entries.len();
    let ifd_at = 8u32;
    let mut extra_at = ifd_at + 2 + 12 * n as u32 + 4;
    let mut extra: Vec<u8> = Vec::new();
    // Where the tiles go: after the directory's values.
    let sizes: usize = entries.iter().map(|e| if e.3.len() > 4 { e.3.len() + (e.3.len() & 1) } else { 0 }).sum();
    let offsets_len = 4 * tiles.len();
    let mut tile_at = extra_at as usize + sizes + offsets_len + 2;
    let mut tile_offsets = Vec::new();
    for t in &tiles {
        tile_offsets.push(tile_at as u32);
        tile_at += t.len();
    }
    let mut out = b"II*\0".to_vec();
    out.extend_from_slice(&ifd_at.to_le_bytes());
    out.extend_from_slice(&(n as u16).to_le_bytes());
    for (tag, typ, count, mut value) in entries {
        if tag == 324 {
            value = long(&tile_offsets);
        }
        out.extend_from_slice(&tag.to_le_bytes());
        out.extend_from_slice(&typ.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        if value.len() <= 4 {
            let mut v = value.clone();
            v.resize(4, 0);
            out.extend_from_slice(&v);
        } else {
            out.extend_from_slice(&extra_at.to_le_bytes());
            let pad = value.len() & 1;
            extra_at += (value.len() + pad) as u32;
            extra.extend_from_slice(&value);
            extra.extend(std::iter::repeat_n(0, pad));
        }
    }
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&extra);
    out.resize(tile_offsets[0] as usize, 0);
    for t in &tiles {
        out.extend_from_slice(t);
    }
    out
}
