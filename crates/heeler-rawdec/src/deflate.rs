//! Deflate-compressed DNG pieces (TIFF compression 8), with the
//! floating-point predictor (TIFF Technical Note 3's predictor 3, and
//! the DNG specification's 34894 and 34895, which difference every
//! second or fourth sample): what HDR merges write.
//!
//! A piece inflates to its rows, each row's samples split into byte
//! planes (every sample's most significant byte first, then the next),
//! the bytes differenced along the row, `factor` samples apart. Undone,
//! each sample is a 16-bit (IEEE half), 24-bit (the DNG specification's:
//! sign, 7-bit exponent biased by 64, 16-bit mantissa) or 32-bit float.

use crate::Error;

/// A piece's samples as floats, `width` by `height` (the piece's size,
/// one sample a pixel), from its compressed bytes.
pub fn floats(data: &[u8], width: usize, height: usize, bits: u32, predictor: u32) -> Result<Vec<f32>, Error> {
    let bytes = (bits / 8) as usize;
    if !matches!(bits, 16 | 24 | 32) {
        return Err(Error::Unsupported("a floating-point depth other than 16, 24 or 32 bits"));
    }
    let factor = match predictor {
        3 => 1,
        34894 => 2,
        34895 => 4,
        _ => return Err(Error::Unsupported("a floating-point predictor other than 3, 34894 or 34895")),
    };
    let row_bytes = width * bytes;
    let raw = miniz_oxide::inflate::decompress_to_vec_zlib_with_limit(data, row_bytes * height).map_err(|_| Error::Corrupt("a Deflate piece"))?;
    if raw.len() < row_bytes * height {
        return Err(Error::Corrupt("a Deflate piece shorter than its rows"));
    }
    let mut out = vec![0f32; width * height];
    let mut row = vec![0u8; row_bytes];
    for (y, dst) in out.chunks_exact_mut(width).enumerate() {
        row.copy_from_slice(&raw[y * row_bytes..(y + 1) * row_bytes]);
        for i in factor..row_bytes {
            row[i] = row[i].wrapping_add(row[i - factor]);
        }
        for (x, v) in dst.iter_mut().enumerate() {
            let b = |plane: usize| row[plane * width + x] as u32;
            *v = match bytes {
                2 => half((b(0) << 8 | b(1)) as u16),
                3 => float24(b(0) << 16 | b(1) << 8 | b(2)),
                _ => f32::from_bits(b(0) << 24 | b(1) << 16 | b(2) << 8 | b(3)),
            };
        }
    }
    Ok(out)
}

/// An uncompressed piece's float samples, `width` by up to `height` (a
/// last strip may hold fewer rows), each in the file's byte order.
pub fn uncompressed_floats(data: &[u8], width: usize, height: usize, bits: u32, little: bool) -> Result<Vec<f32>, Error> {
    let bytes = (bits / 8) as usize;
    if !matches!(bits, 16 | 24 | 32) {
        return Err(Error::Unsupported("a floating-point depth other than 16, 24 or 32 bits"));
    }
    let n = (data.len() / bytes).min(width * height) / width * width;
    Ok(data[..n * bytes]
        .chunks_exact(bytes)
        .map(|b| {
            let v = b.iter().enumerate().fold(0u32, |acc, (i, &x)| if little { acc | (x as u32) << (8 * i) } else { acc << 8 | x as u32 });
            match bytes {
                2 => half(v as u16),
                3 => float24(v),
                _ => f32::from_bits(v),
            }
        })
        .collect())
}

/// An IEEE 754 half-precision value.
fn half(h: u16) -> f32 {
    let sign = if h & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exp = ((h >> 10) & 31) as i32;
    let man = (h & 0x3ff) as f32;
    sign * match exp {
        0 => man * 2f32.powi(-24),
        31 => if man == 0.0 { f32::INFINITY } else { f32::NAN },
        _ => (1.0 + man / 1024.0) * 2f32.powi(exp - 15),
    }
}

/// The DNG specification's 24-bit float: sign, a 7-bit exponent biased by
/// 64, a 16-bit mantissa.
fn float24(v: u32) -> f32 {
    let sign = if v & 0x80_0000 != 0 { -1.0 } else { 1.0 };
    let exp = ((v >> 16) & 0x7f) as i32;
    let man = (v & 0xffff) as f32;
    sign * match exp {
        0 => man * 2f32.powi(-62 - 16),
        127 => if man == 0.0 { f32::INFINITY } else { f32::NAN },
        _ => (1.0 + man / 65536.0) * 2f32.powi(exp - 63),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn half_and_24_bit_floats_read_as_their_values() {
        assert_eq!(half(0x3c00), 1.0);
        assert_eq!(half(0xc000), -2.0);
        assert_eq!(half(0x7bff), 65504.0);
        assert_eq!(half(0x0001), 2f32.powi(-24));
        // 1.0 and 1.5 in 24 bits: exponent 63, mantissa 0 and half.
        assert_eq!(float24(63 << 16), 1.0);
        assert_eq!(float24(63 << 16 | 0x8000), 1.5);
        assert_eq!(float24(0x80_0000 | 64 << 16), -2.0);
    }

    #[test]
    fn a_predicted_piece_round_trips() {
        // Encode a 5 by 3 piece of 32-bit floats as a writer would: byte
        // planes, differenced two samples apart, deflated.
        let (w, h) = (5usize, 3usize);
        let values: Vec<f32> = (0..w * h).map(|i| i as f32 * 1.25 - 3.0).collect();
        let mut raw = Vec::new();
        for y in 0..h {
            let mut row = vec![0u8; w * 4];
            for x in 0..w {
                let b = values[y * w + x].to_bits().to_be_bytes();
                for plane in 0..4 {
                    row[plane * w + x] = b[plane];
                }
            }
            for i in (2..row.len()).rev() {
                row[i] = row[i].wrapping_sub(row[i - 2]);
            }
            raw.extend_from_slice(&row);
        }
        let data = miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6);
        assert_eq!(floats(&data, w, h, 32, 34894).unwrap(), values);
    }
}
