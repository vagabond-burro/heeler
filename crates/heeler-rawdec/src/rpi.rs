//! The Raspberry Pi camera's raw captures (a JPEG with the sensor's frame
//! appended), read into the DNG terms a develop needs (dng.rs). Each rule
//! was found from the data against LibRaw's unpacked frame and numbers.
//!
//! The frame is a block at the file's end, starting "BRCM": a header of
//! 32768 bytes naming the sensor (at byte 16) and its mode (at byte 176),
//! then the rows (the files seen hold 16 past the image's),
//! each a whole number of 32 bytes, of 10-bit samples
//! packed four in five bytes (the four samples' top 8 bits, then a byte of
//! their low 2 bits, the first sample's lowest). Only the IMX219 at its
//! full size ("full" or "full2", 3280 by 2464) is read. The white balance is the
//! JPEG's maker note's text, "gain_r=" and "gain_b=" (green 1). The black
//! level is LibRaw's for the sensor (66; no byte of the header or the
//! frame moves it). The image area, CFA colors and white level come from
//! geometry.rs, the calibrations from cameras.rs.

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::Error;

/// The IMX219's full-size frame.
const IMX219: (usize, usize) = (3280, 2464);

/// LibRaw's black level for the IMX219.
const IMX219_BLACK: f64 = 66.0;

/// The block's header bytes.
const HEADER: usize = 32768;

/// Where the frame's block starts.
fn block(bytes: &[u8]) -> Option<usize> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }
    let (w, h) = IMX219;
    // The block ends the file, with up to 32 rows past the image's.
    let named = |at: usize, s: &[u8]| bytes.get(at..at + s.len()) == Some(s) && bytes.get(at + s.len()).is_some_and(|&c| c == 0 || c == b' ');
    (h..=h + 32).filter_map(|rows| bytes.len().checked_sub(HEADER + row_bytes(w) * rows)).find(|&at| bytes[at..].starts_with(b"BRCM") && named(at + 16, b"imx219") && (named(at + 176, b"full") || named(at + 176, b"full2")))
}

/// A row's bytes: the packed samples, rounded up to 32.
fn row_bytes(width: usize) -> usize {
    (width * 5 / 4).div_ceil(32) * 32
}

/// Whether `bytes` are such a capture.
pub fn is_rpi(bytes: &[u8]) -> bool {
    block(bytes).is_some()
}

/// Make and Model as LibRaw names the camera.
pub fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    is_rpi(bytes).then(|| ("Broadcom".to_string(), "RPi IMX219".to_string()))
}

/// One row's samples.
pub fn unpack_row(row: &[u8], line: &mut [u16]) {
    for (g, out) in row.chunks(5).zip(line.chunks_mut(4)) {
        for (k, v) in out.iter_mut().enumerate() {
            *v = (g[k] as u16) << 2 | (g[4] >> (2 * k) & 3) as u16;
        }
    }
}

/// The gains of the maker note's text: red's and blue's.
fn gains(bytes: &[u8]) -> Option<(f32, f32)> {
    let text = &bytes[..bytes.len().min(65536)];
    let find = |key: &[u8]| -> Option<f32> {
        let i = text.windows(key.len()).position(|w| w == key)? + key.len();
        let end = text[i..].iter().position(|&c| !(c.is_ascii_digit() || c == b'.'))? + i;
        std::str::from_utf8(&text[i..end]).ok()?.parse().ok()
    };
    Some((find(b"gain_r=")?, find(b"gain_b=")?)).filter(|&(r, b)| r > 0.0 && b > 0.0)
}

pub fn parse(bytes: &[u8]) -> Result<Dng, Error> {
    let at = block(bytes).ok_or(Error::Unsupported("not a Raspberry Pi capture"))?;
    let (make, model) = ("Broadcom".to_string(), "RPi IMX219".to_string());
    let (width, height) = IMX219;
    let (r, b) = gains(bytes).ok_or(Error::Unsupported("no stated white balance"))?;
    let geometry = crate::geometry::find(&make, &model, (width as u32, height as u32)).ok_or(Error::Unsupported("a camera and frame size without geometry"))?;
    let calibration = crate::cameras::find(&make, &model).ok_or(Error::Unsupported("a camera without calibrations"))?;
    let m = |v: &Option<[f64; 9]>| v.map(|v| v.to_vec());
    let (top, left) = (geometry.top as usize, geometry.left as usize);
    let start = at + HEADER;
    Ok(Dng {
        format: Format::Headerless,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation: 1,
        width,
        height,
        bits: 10,
        compression: 1,
        photometric: 32803,
        samples: 1,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: vec![(start, bytes.len() - start)] },
        cfa_dim: (2, 2),
        cfa: geometry.colors.to_vec(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![IMX219_BLACK],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![geometry.white as f64],
        active: (top, left, top + geometry.height as usize, left + geometry.width as usize),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![1.0 / r as f64, 1.0, 1.0 / b as f64]),
        as_shot_white_xy: None,
        color_matrix: [m(&calibration.color_matrix[0]), m(&calibration.color_matrix[1]), None],
        camera_calibration: [None, None, None],
        illuminant: [calibration.illuminants[0], calibration.illuminants[1], 0],
        analog_balance: None,
        forward_matrix: [m(&calibration.forward_matrix[0]), m(&calibration.forward_matrix[1]), None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: calibration.tables,
        baseline_exposure: 0.0,
        coding: Coding::Raw10 { stride: row_bytes(width) },
        cam_mul: Some([r, 1.0, b, 1.0]),
        border_black: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn four_samples_in_five_bytes() {
        let mut line = [0u16; 4];
        unpack_row(&[0x1c, 0x1f, 0x1b, 0x20, 0b10_01_11_10], &mut line);
        assert_eq!(line, [0x1c << 2 | 2, 0x1f << 2 | 3, 0x1b << 2 | 1, 0x20 << 2 | 2]);
        assert_eq!(row_bytes(3280), 4128);
    }
}
