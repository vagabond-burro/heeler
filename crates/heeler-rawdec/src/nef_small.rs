//! Nikon's small raw NEF (the S size the D810, D810A and D4S write): a
//! frame of luma and chroma rather than a mosaic, turned into RGB as
//! LibRaw turns it, every rule found against LibRaw's unpacked image.
//!
//! The raw directory says CFA, Nikon's compression (34713) and 12 bits, as
//! a full-size NEF's does, and the maker notes' NEF compression is 8; the
//! frame is about half the full size's width and height, one strip of
//! three bytes a pixel. Each two pixels of a row are 48 bits,
//! little-endian: the left pixel's luma in bits 0 to 11, the right's in 12
//! to 23, then Cb and Cr, each about 2048. The left pixel takes its pair's
//! chroma; the right pixel takes the mean of its pair's and the next
//! pair's (the sum halved, rounded down), the last pair of a row its own.
//!
//! With Cb and Cr less 2048, doubled, and the luma scaled by 3072 / 2549,
//!
//!   R = 3072 Y / 2549 + 1.402 Cr
//!   G = 3072 Y / 2549 - 0.34414 Cb - 0.71414 Cr
//!   B = 3072 Y / 2549 + 1.772 Cb
//!
//! each rounded down to an index into a curve of 3073 points (an index
//! below 0 takes the first, above 3072 the last), whose values are the
//! pixel's: 0 for points 0 to 60, rising to 16287 at 3072. A pixel whose
//! luma is 2047 or more ignores its chroma: its three channels take the
//! luma's point. The curve is not in the file and is the same for the
//! three bodies: its points were measured from LibRaw's image of frames
//! made to reach each one.
//!
//! LibRaw computes the sums in a rounding of its own that was not found:
//! a sum within about 0.0003 of a whole number can fall on the other side
//! of it there, so about one sample in twenty thousand of a corpus file is
//! one step of the curve away from LibRaw's.
//!
//! LibRaw's white level for the image is 16383, its black 0, and it
//! develops it with no white balance (its scaled multipliers all 1) and no
//! camera matrix (rgb_cam the identity).

use heeler_engine::memory;
use rayon::prelude::*;

use crate::dng::{Coding, Dng, Format, Pieces};
use crate::tiff::Tiff;
use crate::Error;

/// Where a small NEF's frame is and its size in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NefSmall {
    /// The strip's offset in the file.
    pub at: usize,
    pub width: usize,
    pub height: usize,
}

/// The white level LibRaw gives the image.
pub const WHITE: u32 = 16383;

/// The curve's steps, one hexadecimal digit each from point 1 to 3072
/// (point 0 is 0).
const STEPS: [&str; 32] = [
    "000000000000000000000000000000000000000000000000000000000000100101001010100101010101101010110110",
    "110110111011101111011111011111111111011111111211111111111211111121111211121112111211211211211212",
    "112121211212121212121212212121221212212122122122122212212221222122221222221222221222222212222222",
    "222222222122222222322222222222222223222222223222222322222322223222232223222232232223222322322322",
    "322232232322322322323223232232322323232232323232323223232323232323233232323232323323232323323233",
    "232332323323233233232332332332332332332332332332333233233323323332333233323332333233323332333323",
    "333233332333323333323333233333323333332333333233333332333333333233333333332333333333333332333333",
    "333333333333333333333333333333333333333333333333333334333333333333334333333333343333333343333333",
    "433333343333343333343333343333433334333343334333433343334333433343334334333433433433433433433433",
    "433433434334334343343433434343343434334343434343434343434343434343434344343434434343443434434434",
    "344344344344344344344434434443444344434444344443444434444443444444344444444443444444444444444444",
    "444444444444544444444445444444544444544445444454445444544544454454454454544544545454454545454545",
    "454545454545545454554554545545545554554555455545555455555455555554555555555555555555555555555556",
    "555555565555655556555655565565565565565565655656565656565656565665656656566566656656665666566665",
    "666666566666666666666666666666666667666666766667666766676676676676676767667676767676776767677677",
    "677677677767776777767777776777777777777777777777778777777877778777877787787787787877878787878787",
    "878788788787887888788788878888878888888788888888888888888988888889888898888988988898898988988989",
    "89898989898989989899899899899899989999899999899999999989999999999a9999999999a99999a999a999a999a9",
    "9a99a99a9a99a9a9a99a9a9a9a9aa9a9a9aa9a9aa9aa9aaa9aa9aaa9aaa9aaaaa9aaaaaa9aaaaaaaaaaaaaaaaaaaaaaa",
    "aaaaaaaabaaaaaabaaaaabaaaabaaabaaabaaabaabaabaabaababaabaabababaabababababababababababababbababa",
    "bbababbababbabbabbabbabbabbabbabbbabbabbbabbbabbbabbbabbbabbbbabbbabbbbabbbbabbbbbabbbbabbbbbabb",
    "bbbabbbbbbabbbbbabbbbbabbbbbbabbbbbabbbbbabbbbbbabbbbabbbbbabbbbabbbbbabbbabbbbabbbbabbbabbbabbb",
    "abbbabbabbbabbabbabbabbabbabbabbababbababbabababbabababababababababaabababaababaabaabaabaabaabaa",
    "abaaabaaaabaaaabaaaaaaabaaaaaaaaaaaaaaaaaaaaaaaa9aaaaaa9aaaaa9aaa9aaa9aa9aa9aa9a9aa9a9a9a9a9a9a9",
    "a99a9a99a99a99a999a999a99999a9999999999999999999999989999989998998999898998989899898898989889889",
    "889888988889888888888888888888888887888878887887887887878787878787877877877877787777877777777777",
    "777777776777776777677677676776767676766767667667666766666766666666666666666656666566656665665656",
    "566565655656556556556555655555655555555555555554555554555455545545455454545454544545445445444544",
    "445444444444454344444444444344443444344344343443434343434343433433433433343334333334333333333333",
    "333333332333333233323332332332332323323232323232323223232232232223222322223222223222222222222222",
    "222222222221222222122212222122122212212122122121212212121212121121212112121121121121121112112111",
    "121111211111211111112111111111111111111111111111111110111111110111110111110111011110111011101101",
];

/// The curve's 3073 points.
fn curve() -> &'static [u16; 3073] {
    static CURVE: std::sync::OnceLock<[u16; 3073]> = std::sync::OnceLock::new();
    CURVE.get_or_init(|| {
        let mut c = [0u16; 3073];
        for (i, s) in STEPS.iter().flat_map(|s| s.bytes()).enumerate() {
            c[i + 1] = c[i] + (s as char).to_digit(16).unwrap_or(0) as u16;
        }
        c
    })
}

/// The small NEF frame of `bytes`, or None when they are not one: a Nikon
/// TIFF whose raw directory (CFA, the full-size image) is Nikon's
/// compression at 12 bits in one strip of exactly three bytes a pixel, the
/// width even.
pub fn frame(bytes: &[u8]) -> Option<NefSmall> {
    let t = Tiff::new(bytes)?;
    let ifds = t.ifds();
    let ifd0 = ifds.first()?;
    if !ifd0.get(271).and_then(|e| t.ascii(&e)).is_some_and(|m| m.to_ascii_uppercase().starts_with("NIKON")) {
        return None;
    }
    let uint = |i: &crate::tiff::Ifd, tag| i.get(tag).and_then(|e| t.uint(&e));
    let raw = ifds.iter().skip(1).find(|i| uint(i, 262) == Some(32803) && uint(i, 254).unwrap_or(0) == 0)?;
    let (width, height) = (uint(raw, 256)? as usize, uint(raw, 257)? as usize);
    let offsets = raw.get(273).and_then(|e| t.uints(&e))?;
    let counts = raw.get(279).and_then(|e| t.uints(&e))?;
    let bits = raw.get(258).and_then(|e| t.uints(&e)).and_then(|b| b.first().copied());
    if uint(raw, 259) != Some(34713) || bits != Some(12) || offsets.len() != 1 || counts.len() != 1 || width == 0 || height == 0 || width % 2 != 0 {
        return None;
    }
    let (at, count) = (offsets[0] as usize, counts[0] as usize);
    (count == width * height * 3 && at.checked_add(count).is_some_and(|e| e <= bytes.len())).then_some(NefSmall { at, width, height })
}

/// The curve's index for a value: rounded down, kept to the curve.
#[inline(always)]
fn index(v: f64) -> usize {
    (v.floor().max(0.0) as usize).min(3072)
}

/// One pixel's RGB from its luma and chroma (as coded).
#[inline(always)]
fn rgb(c: &[u16; 3073], y: u16, cb: u16, cr: u16) -> [u16; 3] {
    let l = y as f64 * (3072.0 / 2549.0);
    if y >= 2047 {
        return [c[index(l)]; 3];
    }
    let (cb, cr) = (2.0 * (cb as f64 - 2048.0), 2.0 * (cr as f64 - 2048.0));
    [c[index(l + 1.402 * cr)], c[index(l - 0.34414 * cb - 0.71414 * cr)], c[index(l + 1.772 * cb)]]
}

/// Decodes the frame into LibRaw's image, three samples a pixel, rows of
/// `width` pixels.
pub fn decode(bytes: &[u8], s: &NefSmall) -> Result<Vec<u16>, Error> {
    let (w, h) = (s.width, s.height);
    let data = s.at.checked_add(w * h * 3).and_then(|e| bytes.get(s.at..e)).ok_or(Error::Corrupt("the frame past the end of the file"))?;
    let c = curve();
    let mut out = memory::vector(w * h * 3, 0u16, "RAW samples")?;
    out.par_chunks_mut(w * 3).zip(data.par_chunks(w * 3)).for_each(|(row, src)| {
        let pair = |m: usize| {
            let b = &src[m * 6..m * 6 + 6];
            let v = u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], 0, 0]);
            [(v & 0xfff) as u16, (v >> 12 & 0xfff) as u16, (v >> 24 & 0xfff) as u16, (v >> 36 & 0xfff) as u16]
        };
        let pairs = w / 2;
        for m in 0..pairs {
            let p = pair(m);
            let n = if m + 1 < pairs { pair(m + 1) } else { p };
            row[m * 6..m * 6 + 3].copy_from_slice(&rgb(c, p[0], p[2], p[3]));
            row[m * 6 + 3..m * 6 + 6].copy_from_slice(&rgb(c, p[1], (p[2] + n[2]) >> 1, (p[3] + n[3]) >> 1));
        }
    });
    Ok(out)
}

/// The frame in the DNG terms a develop needs: an image of three samples a
/// pixel, black 0, LibRaw's white level, no matrix and no balance (LibRaw
/// develops it with its multipliers all 1 and rgb_cam the identity).
pub fn dng(s: NefSmall, make: String, model: String, orientation: u16) -> Result<Dng, Error> {
    let (width, height) = (s.width, s.height);
    let white = WHITE as f64;
    Ok(Dng {
        format: Format::NefSmall,
        make,
        model: model.clone(),
        unique_model: model,
        version: [0, 0, 0, 0],
        orientation,
        width,
        height,
        bits: 16,
        compression: 1,
        photometric: 34892,
        samples: 3,
        sample_format: 1,
        predictor: 1,
        pieces: Pieces { width, height, spans: Vec::new() },
        cfa_dim: (0, 0),
        cfa: Vec::new(),
        cfa_layout: 1,
        linearization: None,
        black_dim: (1, 1),
        black: vec![0.0],
        black_delta_h: Vec::new(),
        black_delta_v: Vec::new(),
        white: vec![white],
        active: (0, 0, height, width),
        default_crop: None,
        default_scale: (1.0, 1.0),
        as_shot_neutral: Some(vec![1.0; 3]),
        as_shot_white_xy: None,
        color_matrix: [None, None, None],
        camera_calibration: [None, None, None],
        illuminant: [0, 0, 0],
        analog_balance: None,
        forward_matrix: [None, None, None],
        opcodes: [Vec::new(), Vec::new(), Vec::new()],
        profile_tables: false,
        baseline_exposure: 0.0,
        coding: Coding::NefSmall(s),
        cam_mul: Some([1.0; 4]),
        border_black: false,
    })
}
