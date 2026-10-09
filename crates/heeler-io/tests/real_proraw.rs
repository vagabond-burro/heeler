//! Opt-in check against real phone DNGs (iPhone ProRAW): the develop,
//! rendered by the gain table map the file carries, against the preview
//! the phone embedded. Run with:
//!   HEELER_PRORAW=/path/a.DNG:/path/b.DNG cargo test -p heeler-io --features libraw --test real_proraw -- --ignored --nocapture
//!
//! The repository carries no phone DNG (they run 20 MB and up), so this
//! is the test that says the stage matches a real file; the unit tests
//! in src/dng_gain.rs hold its arithmetic. examples/gainprobe.rs prints
//! the same numbers for reading.

use std::path::PathBuf;

use heeler_engine::ops::to_display;
use heeler_engine::ImageBuf;

const ACROSS: usize = 32;
const DOWN: usize = 24;

/// Cell means of the picture's luma, in display values (0 to 255).
fn cells(img: &ImageBuf) -> Vec<f32> {
    let mut sum = vec![0f64; ACROSS * DOWN];
    let mut n = vec![0u32; ACROSS * DOWN];
    for y in 0..img.height {
        let cy = y * DOWN / img.height;
        for x in 0..img.width {
            let cx = x * ACROSS / img.width;
            let o = (y * img.width + x) * 4;
            let d = &img.data[o..o + 3];
            let luma = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
            sum[cy * ACROSS + cx] += to_display(luma.clamp(0.0, 1.0)) as f64 * 255.0;
            n[cy * ACROSS + cx] += 1;
        }
    }
    sum.iter().zip(&n).map(|(s, n)| (*s / (*n).max(1) as f64) as f32).collect()
}

#[test]
#[ignore]
fn a_phone_dng_develops_to_the_picture_its_preview_shows() {
    let Some(list) = std::env::var_os("HEELER_PRORAW") else {
        eprintln!("HEELER_PRORAW not set; skipping");
        return;
    };
    let mut off: Vec<String> = Vec::new();
    for path in std::env::split_paths(&list).map(PathBuf::from) {
        let bytes = std::fs::read(&path).unwrap();
        assert!(heeler_io::dng_gain::file_rendering(&bytes).is_some(), "{} carries no gain table map", path.display());
        // A missing or unreadable embedded preview leaves no comparison oracle.
        let Some(preview) = heeler_io::extract_raw_preview(&bytes).and_then(|p| heeler_io::decode_bytes(p).ok()) else {
            println!("{}: no readable preview, skipped", path.display());
            continue;
        };
        let ours = cells(&heeler_io::decode_any(&path).unwrap());
        // The preview tier's develop is the same picture: the viewer
        // shows one while the export writes the other.
        let tier = cells(&heeler_io::decode_preview_at(&path, heeler_io::RawSourceOpts::default(), 2048).unwrap());
        let apart = ours.iter().zip(&tier).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
        assert!(apart < 1.5, "{}: the preview develop is {apart:.1} display levels from the full one", path.display());
        let theirs = cells(&heeler_io::apply_orientation(preview, heeler_io::raw_orientation(&bytes)));
        let n = ours.len() as f32;
        let bias = ours.iter().zip(&theirs).map(|(a, b)| a - b).sum::<f32>() / n;
        let spread = ours.iter().zip(&theirs).map(|(a, b)| (a - b - bias).abs()).sum::<f32>() / n;
        println!("{}: bias {bias:+.1}, spread {spread:.1}", path.display());
        // Unrendered, the 2026-10-02 folder ran from -54 to +103 in
        // bias and up to 22 in spread. These bounds catch a lost stage,
        // not equivalence to the phone's finished preview.
        if bias.abs() >= 16.0 || spread >= 8.0 {
            off.push(format!("{}: bias {bias:+.1}, spread {spread:.1}", path.display()));
        }
    }
    assert!(off.is_empty(), "outside the measured review bounds:\n{}", off.join("\n"));
}

#[test]
#[ignore]
fn every_phone_preview_uses_a_decodable_declared_jpeg_strip() {
    let Some(list) = std::env::var_os("HEELER_PRORAW") else { return };
    for path in std::env::split_paths(&list) {
        let bytes = std::fs::read(&path).unwrap();
        let preview = heeler_io::extract_raw_preview(&bytes).unwrap();
        let img = heeler_io::decode_bytes(preview).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        assert!(img.width >= 1000 && img.height >= 1000);
        println!("{}: {} preview bytes, {}x{}", path.display(), preview.len(), img.width, img.height);
    }
}

#[test]
#[ignore]
fn real_phone_full_half_and_thumbnail_paths_follow_all_eight_orientations() {
    let Some(list) = std::env::var_os("HEELER_PRORAW") else { return };
    let first = std::env::split_paths(&list).next().unwrap();
    let mut bytes = std::fs::read(first).unwrap();
    assert_eq!(&bytes[..2], b"MM");
    let ifd = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
    let n = u16::from_be_bytes(bytes[ifd..ifd + 2].try_into().unwrap()) as usize;
    let at = (0..n).map(|i| ifd + 2 + i * 12).find(|&i| u16::from_be_bytes(bytes[i..i + 2].try_into().unwrap()) == 274).unwrap() + 8;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("orientation.DNG");
    let decode = |p: &std::path::Path, tier| match tier {
        0 => heeler_io::decode_any(p).unwrap(),
        1 => heeler_io::decode_preview_at(p, heeler_io::RawSourceOpts::default(), 2048).unwrap(),
        _ => heeler_io::decode_thumbnail(p).unwrap(),
    };
    bytes[at..at + 2].copy_from_slice(&1u16.to_be_bytes());
    std::fs::write(&path, &bytes).unwrap();
    let original: Vec<_> = (0..3).map(|tier| decode(&path, tier)).collect();
    for orientation in 2u16..=8 {
        bytes[at..at + 2].copy_from_slice(&orientation.to_be_bytes());
        std::fs::write(&path, &bytes).unwrap();
        for tier in 0..3 {
            let base = &original[tier];
            // Use the image library's separate transforms as the oracle,
            // rather than apply_orientation or sensor_position again.
            let b = image::ImageBuffer::<image::Rgba<f32>, _>::from_raw(base.width as u32, base.height as u32, base.data.clone()).unwrap();
            let expected = match orientation {
                2 => image::imageops::flip_horizontal(&b),
                3 => image::imageops::rotate180(&b),
                4 => image::imageops::flip_vertical(&b),
                5 => image::imageops::flip_horizontal(&image::imageops::rotate90(&b)),
                6 => image::imageops::rotate90(&b),
                7 => image::imageops::flip_vertical(&image::imageops::rotate90(&b)),
                _ => image::imageops::rotate270(&b),
            };
            let actual = decode(&path, tier);
            assert_eq!((actual.width as u32, actual.height as u32), expected.dimensions(), "orientation {orientation}, tier {tier}");
            let mut worst = 0f32;
            for y in (0..actual.height).step_by(31) {
                for x in (0..actual.width).step_by(29) {
                    for c in 0..3 { worst = worst.max((actual.pixel(x, y)[c] - expected.get_pixel(x as u32, y as u32)[c]).abs()); }
                }
            }
            println!("orientation {orientation}, tier {tier}: worst {worst}");
            assert!(worst < 0.003, "orientation {orientation}, tier {tier}: {worst}");
        }
    }
}

#[test]
#[ignore]
fn phone_rendering_reaches_nondefault_raw_options() {
    let Some(list) = std::env::var_os("HEELER_PRORAW") else { return };
    let path = std::env::split_paths(&list).next().unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let rendering = heeler_io::dng_gain::file_rendering(&bytes).unwrap();
    for (highlight, camera_wb, camera_matrix) in [(2,true,true), (3,true,true), (9,true,true), (0,false,true), (0,true,false)] {
        let opts = heeler_io::RawSourceOpts { highlight, camera_wb, camera_matrix, capture_sharpen: 0, ..Default::default() };
        let raw = heeler_raw::decode_sensor_with(&bytes, heeler_raw::DevelopOpts { highlight, camera_wb, camera_matrix, ..Default::default() }).unwrap();
        let mut oracle = ImageBuf::new(raw.width, raw.height);
        for (px, rgb) in oracle.data.chunks_exact_mut(4).zip(raw.rgb.chunks_exact(3)) {
            for c in 0..3 { px[c] = rgb[c] as f32 / 65535.0 * raw.headroom.max(1.0); }
            px[3] = 1.0;
        }
        heeler_io::dng_gain::render(&mut oracle, &rendering);
        let full = heeler_io::decode_any_with(&path, opts).unwrap();
        assert_eq!(full.data, oracle.data, "options {highlight}/{camera_wb}/{camera_matrix}");
        let tier = heeler_io::decode_preview_at(&path, opts, 2048).unwrap();
        let worst = cells(&full).iter().zip(cells(&tier)).map(|(a,b)| (a-b).abs()).fold(0f32,f32::max);
        assert!(worst < 1.5, "options {highlight}/{camera_wb}/{camera_matrix}: tier {worst}");
        println!("options {highlight}/{camera_wb}/{camera_matrix}: full matches explicit stage, tier worst {worst}");
    }
}

/// A stack's members take a phone DNG scene-linear (2026-10-03:
/// "stacks use scene-linear, panoramas keep phone rendering"): exactly
/// the develop the file's rendering is then applied to, at the full
/// and the preview tier.
#[test]
#[ignore]
fn the_scene_linear_decode_of_a_real_phone_file_is_its_develop_before_the_rendering() {
    let Some(list) = std::env::var_os("HEELER_PRORAW") else { return };
    for path in std::env::split_paths(&list).take(2) {
        let bytes = std::fs::read(&path).unwrap();
        let rendering = heeler_io::dng_gain::file_rendering(&bytes).expect("a gain table map");
        let opts = heeler_io::RawSourceOpts::default();
        let rendered = heeler_io::decode_any_with(&path, opts).unwrap();
        let mut scene = heeler_io::decode_any_scene_linear(&path, opts).unwrap();
        assert_ne!(scene.data, rendered.data, "{}", path.display());
        heeler_io::dng_gain::render(&mut scene, &rendering);
        assert_eq!(scene.data, rendered.data, "{}", path.display());
        let tier = heeler_io::decode_preview_at(&path, opts, 2048).unwrap();
        let mut scene_tier = heeler_io::decode_preview_scene_linear_at(&path, opts, 2048).unwrap();
        heeler_io::dng_gain::render(&mut scene_tier, &rendering);
        assert_eq!(scene_tier.data, tier.data, "{}", path.display());
    }
}
