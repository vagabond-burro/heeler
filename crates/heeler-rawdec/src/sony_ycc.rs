//! Sony's M and S size raw files: an ARW whose raw directory is YCbCr
//! (photometric 6), the luma sampled 2 by 2 (M) or 2 by 1 (S) for each Cb and Cr, in tiles of
//! lossless JPEG (compression 7), turned into RGB as LibRaw turns them,
//! every rule found against LibRaw's unpacked image.
//!
//! Each tile decodes as ljpeg::decode_subsampled_planes. Every pixel takes
//! its own MCU's chroma (no filling in between), and with Cb and Cr less
//! 16383, in single precision, each step a fused multiply-add, truncated,
//! then 1024 off:
//!
//!   R = Y + 1.402 Cr
//!   G = (Y - 0.34414 Cb) - 0.71414 Cr
//!   B = Y + 1.772 Cb
//!
//! clipped to 16 bits: the image LibRaw holds once it has taken off its
//! black level. The single precision, the fused steps and the green's
//! order and weights decide a sum within a hair of a whole number (about
//! one pixel in twenty thousand), found against every pixel of the
//! corpus's files.

use rayon::prelude::*;

use crate::Error;

/// How a Sony YCbCr frame is laid out.
#[derive(Clone, Debug, PartialEq)]
pub struct SonyYcc {
    /// The frame's tiles: their size and each one's bytes, row by row.
    pub tile: (usize, usize),
    /// The luma's sampling: 2 by 2 (M) or 2 by 1 (S).
    pub sampling: (usize, usize),
    pub spans: Vec<(usize, usize)>,
    /// The frame's width (the tiles' grid covers it).
    pub frame_width: usize,
    /// The image LibRaw makes of the frame, from its top left.
    pub image: (usize, usize),
}

#[inline(always)]
fn clip(v: f32) -> u16 {
    (v.floor() as f64 - 1024.0).clamp(0.0, 65535.0) as u16
}

/// One pixel's RGB from its luma and its MCU's chroma (as coded): in
/// single precision, each step a fused multiply-add (one rounding).
#[inline(always)]
fn rgb(y: u16, cb: u16, cr: u16) -> [u16; 3] {
    let (y, cb, cr) = (y as f32, (cb as i32 - 16383) as f32, (cr as i32 - 16383) as f32);
    [clip(cr.mul_add(1.402, y)), clip(cr.mul_add(-0.71414, cb.mul_add(-0.34414, y))), clip(cb.mul_add(1.772, y))]
}

/// Decodes the frame into LibRaw's image, three samples a pixel.
pub fn decode(bytes: &[u8], s: &SonyYcc) -> Result<Vec<u16>, Error> {
    let (w, h) = s.image;
    let (tw, th) = s.tile;
    let across = s.frame_width.div_ceil(tw);
    // Each tile decoded on its own, across the cores, then placed.
    let results: Vec<Result<(usize, usize, Vec<u16>), Error>> = s
        .spans
        .par_iter()
        .enumerate()
        .filter(|(i, _)| (i / across) * th < h && (i % across) * tw < w)
        .map(|(i, &(at, len))| {
            let data = bytes.get(at..at + len).ok_or(Error::Corrupt("a tile past the end of the file"))?;
            let (ty, tx) = ((i / across) * th, (i % across) * tw);
            let (cw, ch) = (tw.min(w - tx), th.min(h - ty));
            let mut px = vec![0u16; cw * ch * 3];
            let mut r = 0;
            let (sh, sv) = s.sampling;
            let n = sh * sv + 2;
            crate::ljpeg::decode_subsampled_planes(data, |_, line| {
                // An MCU row: the MCU's luma samples row by row, Cb, Cr.
                for m in 0..line.len() / n {
                    let c = &line[m * n..m * n + n];
                    for k in 0..sh * sv {
                        let (y, x) = (sv * r + k / sh, sh * m + k % sh);
                        if y < ch && x < cw {
                            px[(y * cw + x) * 3..][..3].copy_from_slice(&rgb(c[k], c[n - 2], c[n - 1]));
                        }
                    }
                }
                r += 1;
            })?;
            Ok((ty, tx, px))
        })
        .collect();
    let mut out = vec![0u16; w * h * 3];
    for res in results {
        let (ty, tx, px) = res?;
        let cw = s.tile.0.min(w - tx);
        for (y, row) in px.chunks(cw * 3).enumerate() {
            out[((ty + y) * w + tx) * 3..][..cw * 3].copy_from_slice(row);
        }
    }
    Ok(out)
}
