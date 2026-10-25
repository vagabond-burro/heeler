//! Canon's sRAW and mRAW: a CR2 whose frame is YCbCr in lossless JPEG,
//! the luma sampled 2 by 1 or 2 by 2 for each Cb and Cr, turned into RGB
//! as LibRaw turns it, every rule found against LibRaw's unpacked image.
//!
//! The scan decodes as ljpeg::decode_subsampled (each line an MCU row, the
//! MCU's luma samples then Cb then Cr), and its samples fill the CR2's
//! slices (0xC640) as a raw frame's do, counted in samples: slice after
//! slice, each top to bottom. A pixel's chroma is its MCU's at the MCU's
//! first pixel; the pixel right of it takes the mean of its MCU's and the
//! next one's (rounded up), the pixel below it the mean of its MCU's and
//! the one below (rounded up), and the pixel diagonal to it the mean of
//! those two vertical means (rounded up); the last column and row take
//! their own MCU's. Then, with Cb and Cr less 16384, in integers:
//!
//!   R = (Y + Cr) mul_r >> 10
//!   G = (Y + ((-778 Cb - 2048 Cr) >> 12)) mul_g >> 10
//!   B = (Y + Cb) mul_b >> 10
//!
//! clipped to 16 bits, with the multipliers from a level set in the maker
//! notes' ColorData (canon.rs). The 40D (ColorData version 3) takes 512
//! off the luma first. The bodies of versions 6, 7 and 9 (the 50D, 5D
//! Mark II, 7D, 60D and 1D Mark IV) convert otherwise: with Cb and Cr less
//! 16384, each times 4 plus an offset (`hue`),
//!
//!   R = Y + ((50 Cb + 22929 Cr) >> 14)
//!   G = Y + ((-5640 Cb - 11751 Cr) >> 14)
//!   B = Y + ((29040 Cb - 101 Cr) >> 14)
//!
//! then each times its multiplier over 1024, clipped. The offset is 4
//! times the MCU's luma samples on the 7D and 50D, twice one less than
//! them on the 5D Mark II, 60D and 1D Mark IV. Those integers are the
//! least-squares fit to LibRaw's image times 4096, and the whole form was
//! then confirmed on every pixel of every such file; its shape matched
//! what was recalled of how such conversions are written, which the docs
//! flag (as for ORF and Fujifilm's compression).

use crate::Error;

/// How an sRAW frame is laid out.
#[derive(Clone, Debug, PartialEq)]
pub struct Sraw {
    /// The luma's sampling, horizontal and vertical: (2, 1) or (2, 2).
    pub sampling: (usize, usize),
    /// The scan's MCUs a line and lines, as its frame header states them
    /// (the mRAWs of some bodies, from the 6D on, state them across the
    /// image's short side; the slices then lay the image out).
    pub scan: (usize, usize),
    /// The CR2's slices: how many before the last, their width and the
    /// last's, in samples; None for the scan's line.
    pub slices: Option<[usize; 3]>,
    /// R, G and B multipliers over 1024.
    pub mul: [i32; 3],
    pub conversion: Conversion,
    /// The image LibRaw makes of the frame, its width and height in
    /// pixels: the frame's own or less (some bodies' mRAWs), its last
    /// column and row the edge chroma is filled to.
    pub image: (usize, usize),
}

/// How a pixel's luma and chroma become RGB (before the multipliers).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Conversion {
    /// The later bodies', the luma less `luma_offset` first (the 40D's 512).
    Later { luma_offset: i64 },
    /// The ColorData version 6, 7 and 9 bodies', with their chroma offset.
    Earlier { hue: i64 },
}

impl Sraw {
    /// The slots of an MCU: its luma samples, Cb and Cr.
    fn slots(&self) -> usize {
        self.sampling.0 * self.sampling.1 + 2
    }

    /// The image's MCUs a row and MCU rows: the slices' width (in
    /// samples) over an MCU's, and the samples over that.
    pub fn grid(&self) -> Option<(usize, usize)> {
        let slots = self.slots();
        let total = self.scan.0 * slots * self.scan.1;
        let line = match self.slices {
            Some([n, w, last]) => n * w + last,
            None => self.scan.0 * slots,
        };
        (line > 0 && line % slots == 0 && total % line == 0).then(|| (line / slots, total / line))
    }

    /// The image's width and height in pixels.
    pub fn size(&self) -> Option<(usize, usize)> {
        self.grid().map(|(m, r)| (m * self.sampling.0, r * self.sampling.1))
    }
}

#[inline(always)]
fn clip(v: i64) -> u16 {
    v.clamp(0, 65535) as u16
}

/// One pixel's RGB from its luma and chroma (as coded, about 16384).
#[inline(always)]
fn rgb(y: i64, cb: i64, cr: i64, mul: &[i32; 3], conversion: Conversion) -> [u16; 3] {
    let (cb, cr) = (cb - 16384, cr - 16384);
    let px = match conversion {
        Conversion::Later { luma_offset } => {
            let y = y - luma_offset;
            [y + cr, y + ((-778 * cb - 2048 * cr) >> 12), y + cb]
        }
        Conversion::Earlier { hue } => {
            let (cb, cr) = ((cb << 2) + hue, (cr << 2) + hue);
            [y + ((50 * cb + 22929 * cr) >> 14), y + ((-5640 * cb - 11751 * cr) >> 14), y + ((29040 * cb - 101 * cr) >> 14)]
        }
    };
    std::array::from_fn(|c| clip((px[c] * mul[c] as i64) >> 10))
}

/// Decodes the scan `data` into RGB, three samples a pixel, rows of
/// `size().0` pixels.
pub fn decode(data: &[u8], s: &Sraw) -> Result<Vec<u16>, Error> {
    decode_pixels(data, s, |y, cb, cr| rgb(y, cb, cr, &s.mul, s.conversion))
}

/// The scan's luma and (filled) chroma for each pixel, as coded, for the
/// harnesses that work a camera's conversion out.
#[doc(hidden)]
pub fn decode_ycbcr(data: &[u8], s: &Sraw) -> Result<Vec<u16>, Error> {
    decode_pixels(data, s, |y, cb, cr| [y as u16, cb as u16, cr as u16])
}

fn decode_pixels(data: &[u8], s: &Sraw, pixel: impl Fn(i64, i64, i64) -> [u16; 3]) -> Result<Vec<u16>, Error> {
    let (h, v) = s.sampling;
    let slots = s.slots();
    let (mcus, rows) = s.grid().ok_or(Error::Corrupt("sRAW slices that do not fit the scan"))?;
    let line = mcus * slots;
    let mut stream = Vec::with_capacity(s.scan.0 * slots * s.scan.1);
    let f = crate::ljpeg::decode_subsampled(data, |_, l| stream.extend_from_slice(l))?;
    if f.sampling != s.sampling || (f.width, f.height) != s.scan || stream.len() != line * rows {
        return Err(Error::Corrupt("an sRAW scan not its frame's size"));
    }
    // The samples in the image's order: slice after slice, each top to
    // bottom.
    let frame = match s.slices {
        Some([n, w, last]) => {
            let mut frame = vec![0u16; line * rows];
            let mut k = 0;
            for sl in 0..=n {
                let ws = if sl < n { w } else { last };
                for r in 0..rows {
                    frame[r * line + sl * w..][..ws].copy_from_slice(&stream[k..k + ws]);
                    k += ws;
                }
            }
            frame
        }
        None => stream,
    };
    // The image: the frame's, or LibRaw's narrower one, whose last column
    // and row the chroma is filled to.
    let (width, height) = s.image;
    if width > mcus * h || height > rows * v || width == 0 || height == 0 {
        return Err(Error::Corrupt("an sRAW image larger than its frame"));
    }
    let (mcus, rows) = (width.div_ceil(h), height.div_ceil(v));
    let mut out = vec![0u16; width * height * 3];
    let ny = h * v;
    let at = |r: usize, m: usize| &frame[r * line + m * slots..][..slots];
    // An MCU's chroma, and its mean with the next one's along a line
    // (rounded up; the last MCU its own).
    let chroma = |r: usize, m: usize| {
        let c = at(r, m);
        (c[ny] as i64, c[ny + 1] as i64)
    };
    let across = |r: usize, m: usize| {
        let (a, b) = chroma(r, m);
        let (c, d) = chroma(r, (m + 1).min(mcus - 1));
        ((a + c + 1) >> 1, (b + d + 1) >> 1)
    };
    let down = |r: usize, m: usize| {
        let (a, b) = chroma(r, m);
        let (c, d) = chroma((r + 1).min(rows - 1), m);
        ((a + c + 1) >> 1, (b + d + 1) >> 1)
    };
    for r in 0..rows {
        for m in 0..mcus {
            let c = at(r, m);
            for dy in 0..v {
                for dx in 0..h {
                    if r * v + dy >= height || m * h + dx >= width {
                        continue;
                    }
                    let y = c[dy * h + dx] as i64;
                    let (cb, cr) = match (dy, dx) {
                        (0, 0) => chroma(r, m),
                        (0, _) => across(r, m),
                        (_, 0) => down(r, m),
                        _ => {
                            let (a, b) = down(r, m);
                            let (cc, d) = down(r, (m + 1).min(mcus - 1));
                            ((a + cc + 1) >> 1, (b + d + 1) >> 1)
                        }
                    };
                    let px = pixel(y, cb, cr);
                    let i = ((r * v + dy) * width + m * h + dx) * 3;
                    out[i..i + 3].copy_from_slice(&px);
                }
            }
        }
    }
    Ok(out)
}
