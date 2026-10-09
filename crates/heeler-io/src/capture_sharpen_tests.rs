//! Capture sharpening at the develop (2026-09-29, two reference RAW
//! editors and Heeler side by side at 100 percent on one RW2: "There
//! is a clear gap in image quality in Heeler"). Every RAW develop
//! elsewhere sharpens by default; Heeler's did not. These hold the
//! develop to it on a synthetic Bayer DNG, and hold a linear DNG (a
//! bake, already developed and sharpened once) out of it.
use super::*;
use std::path::PathBuf;

/// A neutral scene: a smooth wall on the left (every photograph has
/// some sky or shadow, where the develop reads its own noise), and on
/// the right texture at a few scales, from coarse to near the sensor's
/// limit, the stuff rock faces and foliage are made of.
fn scene(x: usize, y: usize) -> f32 {
    if x < 48 {
        return 0.18;
    }
    let (x, y) = (x as f32, y as f32);
    let t = |p: f32| (std::f32::consts::TAU * x / p).sin() * (std::f32::consts::TAU * y / (p * 1.37)).sin();
    0.18 * (1.0 + 0.35 * t(23.0) + 0.25 * t(7.3) + 0.2 * t(3.7))
}

fn mosaic_file(dir: &Path, name: &str) -> PathBuf {
    let (w, h) = (192usize, 160usize);
    let mut m = vec![0u16; w * h];
    for y in 0..h {
        for x in 0..w {
            m[y * w + x] = (scene(x, y).clamp(0.0, 1.0) * 65535.0).round() as u16;
        }
    }
    let path = dir.join(name);
    std::fs::write(&path, crate::bake::encode_cfa_dng(&m, w, h)).unwrap();
    path
}

/// RMS of luma minus its 3x3 mean, in display encoding and 8-bit
/// levels, away from the borders: the finest detail a crop shows.
fn fine_detail(img: &ImageBuf) -> f32 {
    let (w, h) = (img.width, img.height);
    let l: Vec<f32> = img
        .data
        .chunks(4)
        .map(|p| heeler_engine::ops::to_display((0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).max(0.0)))
        .collect();
    let (mut s, mut n) = (0.0f64, 0usize);
    for y in 8..h - 8 {
        for x in 8..w - 8 {
            let mut m = 0.0;
            for dy in 0..3 {
                for dx in 0..3 {
                    m += l[(y + dy - 1) * w + x + dx - 1];
                }
            }
            let d = (l[y * w + x] - m / 9.0) as f64;
            s += d * d;
            n += 1;
        }
    }
    ((s / n as f64).sqrt() * 255.0) as f32
}

fn off() -> RawSourceOpts {
    RawSourceOpts { capture_sharpen: 0, ..RawSourceOpts::default() }
}

#[test]
fn a_raw_develops_capture_sharpened_by_default() {
    let dir = tempfile::tempdir().unwrap();
    let path = mosaic_file(dir.path(), "mosaic.dng");
    let sharp = decode_any_with(&path, RawSourceOpts::default()).unwrap();
    let plain = decode_any_with(&path, off()).unwrap();
    assert_eq!((sharp.width, sharp.height), (plain.width, plain.height));
    let (a, b) = (fine_detail(&sharp), fine_detail(&plain));
    // Measured 2026-09-29: the unsharpened develop's fine band is what
    // every Heeler RAW looked like at 100 percent before this.
    assert!(a > b * 1.2, "the default develop is not sharpened: fine detail {a:.3} against {b:.3} with it off");
    // Sharpening, not a brightness change: the mean stays put.
    let mean = |i: &ImageBuf| i.data.chunks(4).map(|p| p[1] as f64).sum::<f64>() / (i.width * i.height) as f64;
    assert!((mean(&sharp) - mean(&plain)).abs() < 0.01 * mean(&plain), "capture sharpening moved the exposure");
}

#[test]
fn the_steps_order_by_strength() {
    let dir = tempfile::tempdir().unwrap();
    let path = mosaic_file(dir.path(), "steps.dng");
    let at = |cs: u8| fine_detail(&decode_any_with(&path, RawSourceOpts { capture_sharpen: cs, ..RawSourceOpts::default() }).unwrap());
    let (none, low, std, high) = (at(0), at(30), at(DEFAULT_CAPTURE_SHARPEN), at(100));
    assert!(none < low && low < std && std < high, "{none} {low} {std} {high}");
}

#[test]
fn the_preview_develop_is_sharpened_too() {
    // The Fit preview's half-size develop takes the same sharpening at
    // its own scale, so the preview shows what the export will.
    let dir = tempfile::tempdir().unwrap();
    let path = mosaic_file(dir.path(), "preview.dng");
    let sharp = decode_preview_with(&path, RawSourceOpts::default()).unwrap();
    let plain = decode_preview_with(&path, off()).unwrap();
    assert!(fine_detail(&sharp) > fine_detail(&plain) * 1.05, "{} against {}", fine_detail(&sharp), fine_detail(&plain));
}

#[test]
fn a_linear_dng_is_never_capture_sharpened() {
    // A bake (or any linear DNG) is pixels a develop already made and,
    // in a bake's case, already sharpened: sharpening it again on every
    // reopen would compound.
    let dir = tempfile::tempdir().unwrap();
    let mut img = ImageBuf::new(96, 80);
    for y in 0..80 {
        for x in 0..96 {
            let v = scene(x, y);
            img.data[(y * 96 + x) * 4..(y * 96 + x) * 4 + 4].copy_from_slice(&[v, v, v, 1.0]);
        }
    }
    let path = dir.path().join("linear.dng");
    std::fs::write(&path, crate::bake::encode_dng(&img, None).unwrap()).unwrap();
    let a = decode_any_with(&path, RawSourceOpts::default()).unwrap();
    let b = decode_any_with(&path, off()).unwrap();
    assert_eq!(a.data, b.data, "a linear DNG was capture sharpened");
}
