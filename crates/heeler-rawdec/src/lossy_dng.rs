//! Lossy DNGs: a raw directory of LinearRaw (photometric 34892), three
//! samples a pixel, in tiles of baseline JPEG (compression 34892, the
//! DNG specification's lossy JPEG), turned into LibRaw's unpacked image,
//! every rule found against it.
//!
//! The files seen hold 8-bit samples (BitsPerSample 8, WhiteLevel 255,
//! no LinearizationTable) and carry the tone that brings them back to
//! linear in OpcodeList2, as one MapPolynomial (DNG opcode 8) a plane.
//! LibRaw's image is, for each pixel, each tile's JPEG pixel turned to
//! RGB, each color then through its plane's polynomial:
//!
//! - Each tile is one baseline JPEG (`jpeg_planes`, the same inverse DCT
//!   and Huffman decoding the DC120's JPEG reads with), its frame the
//!   tile's size, with a restart interval. It has three components, each
//!   sampled 1 by 1, and an APP14 marker stating transform 1: YCbCr.
//! - A pixel's RGB is the JFIF conversion in 16-bit fixed point, with Cb
//!   and Cr less 128: R = Y + 1.402 Cr, G = Y - 0.34414 Cb - 0.71414 Cr,
//!   B = Y + 1.772 Cb, each constant times 65536 rounded, each product
//!   sum plus a half (32768) shifted down 16 bits, the result limited to
//!   0 to 255 (`ycc_to_rgb`).
//! - The tiles go row by row from the top left, TileWidth by TileLength
//!   each; a tile past the image's right or bottom edge is cut there.
//! - Each color c is then looked up in a curve of 256 entries made from
//!   the MapPolynomial of plane c: with x = v / 255 and the polynomial's
//!   coefficients a0 to an (degree n), entry v is
//!   floor(65535 (a0 + a1 x + ... + an x^n)), in double precision, from
//!   an down (`curve`). LibRaw's maximum for the image is then 65535 and its
//!   black 0.
//!
//! The two files seen (one camera, a full-size and a downscaled
//! conversion, tiles 480 by 480 and 496 by 528, the second's last column
//! of tiles cut to 488) are equal to LibRaw's image sample for sample.
//! The curve's rule fits all 1536 of their entries; rounding to nearest,
//! a scale of 65536 or x = v / 256 each miss more than 60 of them.
//!
//! What the files did not show is declined (Unsupported) rather than
//! guessed: another number of samples (a lossy CFA image), JPEG
//! components sampled other than 1 by 1, another color transform (or no
//! APP14 marker), a LinearizationTable (the caller's to decline: neither
//! function sees it), an OpcodeList2 with any opcode
//! but MapPolynomial, or a polynomial over less than the whole image,
//! over more than one plane, with pitches other than 1, or a plane
//! without one.

use rayon::prelude::*;

use crate::kodak_codec::{jpeg_planes, Planes};
use crate::Error;

/// One color's curve: the 8-bit sample to LibRaw's 16-bit one.
pub type Curve = [u16; 256];

/// A big-endian reader over an opcode list.
struct Be<'a>(&'a [u8], usize);

impl Be<'_> {
    fn u32(&mut self) -> Result<u32, Error> {
        let b = self.0.get(self.1..self.1 + 4).ok_or(Error::Corrupt("an opcode list cut short"))?;
        self.1 += 4;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }
    fn f64(&mut self) -> Result<f64, Error> {
        let b = self.0.get(self.1..self.1 + 8).ok_or(Error::Corrupt("an opcode list cut short"))?;
        self.1 += 8;
        Ok(f64::from_be_bytes(b.try_into().unwrap()))
    }
}

/// The curve of a MapPolynomial's coefficients (a0 first): entry v is
/// floor(65535 p(v / 255)), p evaluated in double precision from the
/// highest coefficient down (y = y x + a, each step two roundings). The
/// order matters to one entry of the files seen, which sits a hair under
/// a whole number: this order and sums of each coefficient times x to its
/// power (as a power function makes it) both give LibRaw's; building
/// the powers by repeated multiplication gives one more. A value outside
/// 0 to 65535 is declined (none in the files seen).
fn curve(coef: &[f64]) -> Result<Curve, Error> {
    let mut out = [0u16; 256];
    for (v, o) in out.iter_mut().enumerate() {
        let x = v as f64 / 255.0;
        let mut y = 0.0f64;
        for &a in coef.iter().rev() {
            y = y * x + a;
        }
        let y = (65535.0 * y).floor();
        if !(0.0..=65535.0).contains(&y) {
            return Err(Error::Unsupported("a lossy DNG's polynomial outside 0 to 65535"));
        }
        *o = y as u16;
    }
    Ok(out)
}

/// The curves of a lossy DNG's colors, one a sample, from its raw
/// directory's OpcodeList2 (the DNG specification's layout, big-endian:
/// the count, then each opcode's ID, version, flags, size in bytes and
/// parameters). A MapPolynomial's parameters are its area (top, left,
/// bottom, right), its plane, its number of planes, its row and column
/// pitches, its degree and its coefficients (degree + 1 doubles).
///
/// Each of the `samples` planes must have one MapPolynomial over the
/// whole `width` by `height` image, one plane, pitches 1; anything else
/// is declined.
pub fn curves(opcode_list2: &[u8], width: usize, height: usize, samples: usize) -> Result<Vec<Curve>, Error> {
    let mut r = Be(opcode_list2, 0);
    let mut out: Vec<Option<Curve>> = vec![None; samples];
    if !opcode_list2.is_empty() {
        for _ in 0..r.u32()? {
            let (id, _version, _flags, size) = (r.u32()?, r.u32()?, r.u32()?, r.u32()? as usize);
            let end = r.1.checked_add(size).filter(|&e| e <= opcode_list2.len()).ok_or(Error::Corrupt("an opcode past its list's end"))?;
            if id != 8 {
                return Err(Error::Unsupported("a lossy DNG opcode other than MapPolynomial"));
            }
            let area = (r.u32()?, r.u32()?, r.u32()?, r.u32()?);
            let (plane, planes, row_pitch, col_pitch, degree) = (r.u32()? as usize, r.u32()?, r.u32()?, r.u32()?, r.u32()? as usize);
            if area != (0, 0, height as u32, width as u32) || planes != 1 || row_pitch != 1 || col_pitch != 1 || plane >= samples || degree > 8 {
                return Err(Error::Unsupported("a lossy DNG polynomial not over one whole plane"));
            }
            let coef = (0..=degree).map(|_| r.f64()).collect::<Result<Vec<_>, _>>()?;
            if r.1 != end || out[plane].is_some() {
                return Err(Error::Corrupt("a MapPolynomial"));
            }
            out[plane] = Some(curve(&coef)?);
        }
    }
    out.into_iter().map(|c| c.ok_or(Error::Unsupported("a lossy DNG plane without a polynomial"))).collect()
}

/// The color transform the APP14 marker states before the JPEG's scan
/// (its segment's five-byte tag, then version, two flag words and the
/// transform: 0 none, 1 YCbCr, 2 YCCK), or None without one.
fn app14_transform(s: &[u8]) -> Option<u8> {
    let mut i = 2;
    while i + 4 <= s.len() && s[i] == 0xff && s[i + 1] != 0xda {
        let len = u16::from_be_bytes([s[i + 2], s[i + 3]]) as usize;
        let seg = s.get(i + 4..i + 2 + len)?;
        if s[i + 1] == 0xee && seg.len() >= 12 && seg.starts_with(&[0x41, 0x64, 0x6f, 0x62, 0x65]) {
            return Some(seg[11]);
        }
        i += 2 + len;
    }
    None
}

/// One pixel's RGB from its Y, Cb and Cr: the JFIF conversion in 16-bit
/// fixed point (each constant times 65536 rounded, plus a half, shifted
/// down 16 bits), limited to 0 to 255.
#[inline(always)]
fn ycc_to_rgb(y: u8, cb: u8, cr: u8) -> [u8; 3] {
    const fn fix(v: f64) -> i32 {
        (v * 65536.0 + 0.5) as i32
    }
    const HALF: i32 = 1 << 15;
    let (y, cb, cr) = (y as i32, cb as i32 - 128, cr as i32 - 128);
    let r = y + ((fix(1.402) * cr + HALF) >> 16);
    let g = y + ((-fix(0.34414) * cb - fix(0.71414) * cr + HALF) >> 16);
    let b = y + ((fix(1.772) * cb + HALF) >> 16);
    [r.clamp(0, 255) as u8, g.clamp(0, 255) as u8, b.clamp(0, 255) as u8]
}

/// A tile's JPEG decoded, checked to be what the files seen hold: three
/// components sampled 1 by 1, YCbCr by its APP14 marker, a frame covering
/// at least `need` (columns, rows).
fn tile_planes(jpeg: &[u8], need: (usize, usize)) -> Result<Planes, Error> {
    if app14_transform(jpeg) != Some(1) {
        return Err(Error::Unsupported("a lossy DNG tile not marked YCbCr"));
    }
    let p = jpeg_planes(jpeg).map_err(|_| Error::Corrupt("a lossy DNG tile's JPEG"))?;
    if p.comps.len() != 3 || p.comps.iter().any(|c| (c.0, c.1) != (1, 1)) {
        return Err(Error::Unsupported("a lossy DNG tile not of three components sampled 1 by 1"));
    }
    if p.width < need.0 || p.height < need.1 {
        return Err(Error::Corrupt("a lossy DNG tile smaller than its place"));
    }
    Ok(p)
}

/// LibRaw's unpacked image of a lossy DNG, `size` (width, height), three
/// samples a pixel (red, green, blue), row by row: from the raw
/// directory's tiles (`spans`, each its offset and byte count in `bytes`,
/// row by row), each `tile` (TileWidth, TileLength) in size, with
/// `samples` the directory's SamplesPerPixel and `curves` one a sample
/// (`curves`). Tiles decode in parallel. The image's maximum is 65535
/// and its black 0, as LibRaw's are, whatever WhiteLevel (255) says.
pub fn decode(bytes: &[u8], spans: &[(usize, usize)], tile: (usize, usize), size: (usize, usize), samples: usize, curves: &[Curve]) -> Result<Vec<u16>, Error> {
    let ((tw, th), (w, h)) = (tile, size);
    if samples != 3 {
        return Err(Error::Unsupported("a lossy DNG not of three samples a pixel"));
    }
    if curves.len() != 3 {
        return Err(Error::Unsupported("a lossy DNG without a curve a color"));
    }
    if tw == 0 || th == 0 || w == 0 || h == 0 {
        return Err(Error::Corrupt("a lossy DNG's size"));
    }
    let across = w.div_ceil(tw);
    if spans.len() != across * h.div_ceil(th) {
        return Err(Error::Corrupt("a lossy DNG's tile count"));
    }
    let mut out = heeler_engine::memory::vector(w * h * 3, 0u16, "RAW samples")?;
    out.par_chunks_mut(th * w * 3).enumerate().try_for_each(|(tr, band)| -> Result<(), Error> {
        let rows = band.len() / (w * 3);
        let band = std::sync::Mutex::new(band);
        (0..across).into_par_iter().try_for_each(|tc| -> Result<(), Error> {
            let (at, len) = spans[tr * across + tc];
            let jpeg = at.checked_add(len).and_then(|e| bytes.get(at..e)).ok_or(Error::Corrupt("a tile past the end of the file"))?;
            let (c0, cols) = (tc * tw, tw.min(w - tc * tw));
            let p = tile_planes(jpeg, (cols, rows))?;
            let mut pixels = vec![0u16; rows * cols * 3];
            for y in 0..rows {
                let (yp, bp, rp) = (&p.comps[0].4[y * p.comps[0].2..], &p.comps[1].4[y * p.comps[1].2..], &p.comps[2].4[y * p.comps[2].2..]);
                for x in 0..cols {
                    let rgb = ycc_to_rgb(yp[x], bp[x], rp[x]);
                    for k in 0..3 {
                        pixels[(y * cols + x) * 3 + k] = curves[k][rgb[k] as usize];
                    }
                }
            }
            let mut band = band.lock().unwrap_or_else(|e| e.into_inner());
            for y in 0..rows {
                band[(y * w + c0) * 3..(y * w + c0 + cols) * 3].copy_from_slice(&pixels[y * cols * 3..(y + 1) * cols * 3]);
            }
            Ok(())
        })
    })?;
    Ok(out)
}
