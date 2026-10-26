//! Fujifilm's SuperCCD RAFs (the sensor turned 45 degrees): where LibRaw
//! puts each sample of the raw frame in the diagonal mosaic it
//! demosaics, and how it turns the developed diagonal image upright.
//! Both rules were found from LibRaw's output alone (patterned frames
//! written into copies of real files, impulses, ramps, and the camera
//! color image LibRaw holds just before its color conversion) and hold
//! to the bit on every pixel of the 27 SuperCCD files checked (E550,
//! E900, S100FS, S2Pro, S3Pro, S5000, S5200, S5600, S5Pro, S6000fd,
//! S6500fd, S7000, S9500, S9600).
//!
//! # The layout
//!
//! A SuperCCD frame is a stack of diagonal lines of the sensor. LibRaw
//! reads one of two arrangements, told apart by the frame's shape:
//!
//! - tall (more rows than columns: E550, E900, S5000, S5200, S5600,
//!   S7000, S9500, S9600): each pair of frame rows is one diagonal line,
//!   the even row holding the line's red and blue sites and the odd row
//!   its greens; the line runs along the frame's columns.
//! - wide (more columns than rows: S100FS, S2Pro, S3Pro, S5Pro, S6000fd,
//!   S6500fd): each frame row is one line, its even columns the red and
//!   blue sites, its odd columns the greens.
//!
//! Either way a line has `fuji_width` positions, each holding two samples
//! (the "half" `e`: 0 the red or blue one, 1 the green), and there are
//! `lines` lines. The image area starts `top` rows and `left` columns into
//! the frame and leaves the same margins at the bottom and right, so
//!
//! - tall: `fuji_width = raw_width - 2 left`, `lines = (raw_height - 2 top) / 2`,
//!   and line `L`, position `P`, half `e` is frame sample (`top + 2L + e`, `left + P`);
//! - wide: `2 fuji_width = raw_width - 2 left`, `lines = raw_height - 2 top`,
//!   and line `L`, position `P`, half `e` is frame sample (`top + L`, `left + 2P + e`).
//!
//! `top`, `left` and `fuji_width` are LibRaw's `top_margin`, `left_margin`
//! and `fuji_width`, and `fuji_width + lines` is its `width` (the
//! diagonal image's width; its `height` is one less). Where LibRaw takes
//! them from in the file is not one rule for every body (see `Layout`).
//!
//! # Placement
//!
//! Sample (`L`, `P`, `e`) goes to the diagonal image's column
//! `x = L + P + e` and row `y = L + fuji_width - 1 - P`. Every sample of
//! the image area lands, none twice, and they fill a diamond completely:
//! the diagonal position (`x`, `y`) holds a sample exactly when, with
//! `s = x - y + fuji_width - 1`, `P = s / 2` (rounded down) is below
//! `fuji_width` and not negative and `L = y - (fuji_width - 1 - P)` is
//! below `lines` and not negative; `e` is then `s` mod 2. The four corners
//! outside the diamond hold no sample (zero). The image is
//! `fuji_width + lines` wide and `fuji_width + lines - 1` high.
//!
//! The diagonal mosaic's colors are LibRaw's `filters` 0x4b4b4b4b for
//! every body, a 2 by 2 pattern on the diagonal image: (even row, even
//! column) green (LibRaw's fourth color, the second green), (even, odd)
//! blue, (odd, even) red, (odd, odd) green. Green falls exactly on the
//! green half `e = 1` (all these bodies have an even `fuji_width`), and
//! red or blue on `e = 0` by the row's parity.
//!
//! SuperCCD SR bodies (S3Pro, S5Pro) store a second frame of the same
//! size after the first, the low sensitivity photodiodes. LibRaw's develop
//! (as Heeler configures it) does not read it: replacing it with noise
//! leaves the developed image unchanged to the bit. The S100FS stores one
//! frame.
//!
//! # The turn
//!
//! With its rotation on (the default), LibRaw turns the demosaiced
//! diagonal image upright after the demosaic and before its color
//! conversion, so `turn` works on the camera color image (black
//! subtracted, white balanced and scaled, three channels: LibRaw has
//! already folded the second green into green). See `turn`.

/// Where one SuperCCD file's samples are: LibRaw's numbers for it.
///
/// LibRaw states them as `top_margin`, `left_margin` and `fuji_width`
/// (its facts after opening the file). In the RAF's records they appear
/// as follows, but not by one rule for every body, so a per-camera table
/// (or LibRaw's facts) is the safe source:
///
/// - tall bodies: record 0x120 holds (`top / 2`, `2 left`) and record 0x121
///   (`lines`, `2 fuji_width`) on all eight;
/// - S100FS, S3Pro, S5Pro: record 0x110 holds (`top`, `left`) and 0x111
///   (`lines`, `2 fuji_width`);
/// - S6000fd, S6500fd: record 0x120 holds (`top`, `left`) and 0x121
///   (`lines`, `2 fuji_width`), not halved or doubled as for the tall
///   bodies (their 0x110 and 0x111 name a smaller crop);
/// - S2Pro: record 0x110 holds `top` and `2 left`, and 0x121
///   (`fuji_width`, `2 lines`).
///
/// The layout itself agrees with record 0x130's first byte on all 14
/// bodies (high bit set exactly for the tall ones), and with the frame's
/// shape, which is what `from_libraw` uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Layout {
    /// Positions along one diagonal line (LibRaw's `fuji_width`).
    pub fuji_width: usize,
    /// Diagonal lines in the image area.
    pub lines: usize,
    /// Frame rows above the image area (LibRaw's `top_margin`).
    pub top: usize,
    /// Frame columns left of the image area (LibRaw's `left_margin`).
    pub left: usize,
    /// Two frame rows a line (true) or one frame row a line (false).
    pub tall: bool,
}

impl Layout {
    /// The layout from LibRaw's frame size and its `top_margin`,
    /// `left_margin` and `fuji_width`. The image area keeps equal margins
    /// on opposite sides, so the lines are what remains of the frame's
    /// rows after two top margins (halved for a tall frame).
    pub fn from_libraw(raw_width: usize, raw_height: usize, top_margin: usize, left_margin: usize, fuji_width: usize) -> Option<Layout> {
        let tall = raw_height > raw_width;
        let rows = raw_height.checked_sub(2 * top_margin)?;
        let lines = if tall { rows / 2 } else { rows };
        let need_cols = if tall { fuji_width } else { 2 * fuji_width };
        if fuji_width == 0 || lines == 0 || left_margin + need_cols > raw_width {
            return None;
        }
        Some(Layout { fuji_width, lines, top: top_margin, left: left_margin, tall })
    }

    /// The diagonal image's width and height (LibRaw's `width` and
    /// `height` for the file).
    pub fn diagonal_size(&self) -> (usize, usize) {
        let w = self.fuji_width + self.lines;
        (w, w - 1)
    }

    /// The frame sample (row, column) at diagonal position (`x`, `y`), or
    /// None where the diagonal image holds no sample.
    #[inline]
    pub fn source(&self, x: usize, y: usize) -> Option<(usize, usize)> {
        let fw = self.fuji_width as isize;
        let s = x as isize - y as isize + fw - 1;
        if s < 0 {
            return None;
        }
        let (p, e) = (s >> 1, (s & 1) as usize);
        let l = y as isize - (fw - 1 - p);
        if p >= fw || l < 0 || l >= self.lines as isize {
            return None;
        }
        let (l, p) = (l as usize, p as usize);
        Some(if self.tall { (self.top + 2 * l + e, self.left + p) } else { (self.top + l, self.left + 2 * p + e) })
    }

    /// The diagonal position (`x`, `y`) of frame sample (`row`, `col`), or
    /// None for a sample outside the image area.
    #[inline]
    pub fn target(&self, row: usize, col: usize) -> Option<(usize, usize)> {
        let (r, c) = (row.checked_sub(self.top)?, col.checked_sub(self.left)?);
        let (l, p, e) = if self.tall { (r / 2, c, r & 1) } else { (r, c / 2, c & 1) };
        if l >= self.lines || p >= self.fuji_width {
            return None;
        }
        Some((l + p + e, l + self.fuji_width - 1 - p))
    }
}

/// LibRaw's color filter pattern for every SuperCCD diagonal mosaic.
pub const FILTERS: u32 = 0x4b4b4b4b;

/// The color of diagonal position (`x`, `y`) in LibRaw's numbering: 0 red,
/// 1 green, 2 blue, 3 the second green. Only meaningful where the
/// position holds a sample (`Layout::source`).
#[inline]
pub fn color(x: usize, y: usize) -> u8 {
    ((FILTERS >> ((((y << 1) & 14) | (x & 1)) << 1)) & 3) as u8
}

/// The diagonal mosaic LibRaw demosaics: each sample of the frame's
/// image area at its diagonal position, raw (black not subtracted), zero
/// where no sample lands. `frame` is `frame_width` by `frame_height`
/// samples. Returns the mosaic with its width and height.
///
/// LibRaw demosaics the whole rectangle, corners included: after its
/// demosaic the positions just outside the diamond's edges are no longer
/// zero (some 7,500 to 14,300 pixels a file, from its interpolation
/// reaching across the edge), and the turn reads some of them, so a
/// demosaic meant to match LibRaw must treat the corners as samples of
/// value zero rather than skip them.
///
/// Checked on all 27 files: with LibRaw's linear demosaic, the own
/// channel of every site of LibRaw's camera color image is one
/// nondecreasing function, per color, of the sample `place` puts there
/// (the second green's two channels equal), and impulses written into
/// the frames peak at the positions `Layout::target` gives.
pub fn place(frame: &[u16], frame_width: usize, frame_height: usize, layout: &Layout) -> (Vec<u16>, usize, usize) {
    let (dw, dh) = layout.diagonal_size();
    let mut out = vec![0u16; dw * dh];
    let rows = if layout.tall { 2 * layout.lines } else { layout.lines };
    let cols = if layout.tall { layout.fuji_width } else { 2 * layout.fuji_width };
    assert!(frame.len() >= frame_width * frame_height && layout.top + rows <= frame_height && layout.left + cols <= frame_width);
    for r in 0..rows {
        let line = &frame[(layout.top + r) * frame_width + layout.left..][..cols];
        for (c, &v) in line.iter().enumerate() {
            let (l, p, e) = if layout.tall { (r / 2, c, r & 1) } else { (r, c / 2, c & 1) };
            out[(l + layout.fuji_width - 1 - p) * dw + l + p + e] = v;
        }
    }
    (out, dw, dh)
}

use crate::fmadd;

/// A SuperCCD RAF's coding: the frame (its size and how its samples are
/// held, raf.rs) and where its samples go.
#[derive(Clone, Debug, PartialEq)]
pub struct SuperCcd {
    pub layout: Layout,
    pub frame: (usize, usize),
    pub samples: crate::headerless::Layout,
}

/// The upright image's width and height for a layout: `(fuji_width - 1)`
/// and `lines` divided by the step (the square root of one half) and
/// rounded down. (The S2Pro's LibRaw output is then turned a further
/// quarter by the file's orientation, as any other file's.)
pub fn turned_size(layout: &Layout) -> (usize, usize) {
    let step = 0.5f64.sqrt();
    (((layout.fuji_width - 1) as f64 / step) as usize, (layout.lines as f64 / step) as usize)
}

/// LibRaw's turn of the demosaiced diagonal image upright.
///
/// `rgb` is the diagonal image in camera colors (three interleaved
/// channels, `dw` by `dh`, as `Layout::diagonal_size`), as it stands
/// after the demosaic. Output pixel (`row`, `col`) samples the diagonal
/// image at
///
/// - `y = fuji_width - 1 + (row - col) * step`,
/// - `x = (row + col) * step`,
///
/// with `step` the square root of one half, both computed in double and
/// then stored as single precision floats. With `y0`, `x0` their integer
/// parts and `fy`, `fx` the single precision remainders, each channel is
/// the bilinear mix of the four samples around, in single precision:
/// `top = a (1 - fx) + b fx`, `bottom = c (1 - fx) + d fx` (`a`, `b` row `y0`,
/// columns `x0` and `x0 + 1`; `c`, `d` row `y0 + 1`), and
/// `top (1 - fy) + bottom fy`, each sum of two products evaluated as one
/// fused multiply-add of the first product onto the second (`fmadd(a, 1 -
/// fx, b * fx)`, on aarch64; two roundings elsewhere), the result truncated
/// to an integer. Output size is `turned_size`. With that size every
/// sample read lies inside the diagonal image on all the bodies checked;
/// a position that would not is left zero here.
pub fn turn(rgb: &[u16], dw: usize, dh: usize, layout: &Layout) -> (Vec<u16>, usize, usize) {
    use rayon::prelude::*;
    let (ow, oh) = turned_size(layout);
    assert!(rgb.len() >= dw * dh * 3);
    let step = 0.5f64.sqrt();
    let fw1 = layout.fuji_width as f64 - 1.0;
    let mut out = vec![0u16; ow * oh * 3];
    out.par_chunks_mut(ow * 3).enumerate().for_each(|(row, line)| {
        for col in 0..ow {
            let yf = (fw1 + (row as f64 - col as f64) * step) as f32;
            let xf = ((row + col) as f64 * step) as f32;
            if yf < 0.0 || xf < 0.0 {
                continue;
            }
            let (y0, x0) = (yf as usize, xf as usize);
            if y0 + 1 >= dh || x0 + 1 >= dw {
                continue;
            }
            let (fy, fx) = (yf - y0 as f32, xf - x0 as f32);
            let (gy, gx) = (1.0 - fy, 1.0 - fx);
            let at = |y: usize, x: usize, k: usize| rgb[(y * dw + x) * 3 + k] as f32;
            for k in 0..3 {
                let top = fmadd(at(y0, x0, k), gx, at(y0, x0 + 1, k) * fx);
                let bottom = fmadd(at(y0 + 1, x0, k), gx, at(y0 + 1, x0 + 1, k) * fx);
                line[col * 3 + k] = fmadd(top, gy, bottom * fy) as u16;
            }
        }
    });
    (out, ow, oh)
}
