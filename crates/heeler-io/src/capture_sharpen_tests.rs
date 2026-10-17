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

/// A raw file's rows made on demand (decode_rows_with) are its decode to
/// the bit: a mosaic develop sharpened at each level, under Clip, Blend
/// (a clipped patch big enough to blend) and Rebuild, and a bake with
/// its exposure put back; read a few rows at a time.
#[test]
fn a_raw_files_rows_made_on_demand_are_its_decode() {
    let dir = tempfile::tempdir().unwrap();
    let plain = mosaic_file(dir.path(), "plain.dng");
    // The same scene with a patch at white, for Blend.
    let (w, h) = (192usize, 160usize);
    let mut m = vec![0u16; w * h];
    for y in 0..h {
        for x in 0..w {
            let v = if (60..90).contains(&x) && (40..70).contains(&y) { 1.0 } else { scene(x, y) };
            m[y * w + x] = (v.clamp(0.0, 1.0) * 65535.0).round() as u16;
        }
    }
    let bright = dir.path().join("bright.dng");
    std::fs::write(&bright, crate::bake::encode_cfa_dng(&m, w, h)).unwrap();
    // A bake past white, which records the exposure it divided down by.
    let mut hot = ImageBuf::new(53, 41);
    for (i, px) in hot.data.chunks_exact_mut(4).enumerate() {
        let v = 0.2 + 2.5 * (i % 53) as f32 / 53.0;
        px.copy_from_slice(&[v, 0.6 * v, 0.3, 1.0]);
    }
    let baked = dir.path().join("baked.dng");
    std::fs::write(&baked, crate::encode_dng_with_xmp(&hot, None, None).unwrap()).unwrap();
    let opts = |highlight: i32, capture_sharpen: u8| RawSourceOpts { highlight, capture_sharpen, ..RawSourceOpts::default() };
    let mut cases = Vec::new();
    for file in [&plain, &bright] {
        for (highlight, sharpen) in [(2, 60), (2, 0), (2, 100), (0, 60), (5, 30)] {
            cases.push((file.clone(), opts(highlight, sharpen)));
        }
    }
    cases.push((baked.clone(), RawSourceOpts::default()));
    for (path, o) in cases {
        let what = format!("{} highlight {} sharpen {}", path.file_name().unwrap().to_string_lossy(), o.highlight, o.capture_sharpen);
        let whole = decode_any_with(&path, o).unwrap();
        let rows = decode_rows_with(&path, o).unwrap().unwrap_or_else(|| panic!("{what}: no rows on demand"));
        assert_eq!(rows.size(), (whole.width, whole.height), "{what}: size");
        let mut made = Vec::new();
        for y in (0..whole.height).step_by(7) {
            made.extend(rows.rows(y, (y + 7).min(whole.height)).unwrap().data);
        }
        assert!(made.len() == whole.data.len() && made.iter().zip(&whole.data).all(|(a, b)| a.to_bits() == b.to_bits()), "{what}: rows differ from the decode");
        assert!(rows.bytes() < whole.data.len() * 4, "{what}: keeps less than the decode");
    }
}

/// The repository's camera RAW (heeler-raw's CR2 fixture), its rows made
/// on demand against its decode, by hand in release:
///   cargo test --release -p heeler-io --features libraw --lib a_camera_raws_rows -- --ignored
#[test]
#[ignore = "develops a camera RAW three ways; run by hand in release"]
fn a_camera_raws_rows_made_on_demand_are_its_decode() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../heeler-raw/tests/fixtures/IMG_3310.CR2");
    for o in [RawSourceOpts::default(), RawSourceOpts { capture_sharpen: 0, ..RawSourceOpts::default() }, RawSourceOpts { highlight: 0, ..RawSourceOpts::default() }] {
        let whole = decode_any_with(&path, o).unwrap();
        let rows = decode_rows_with(&path, o).unwrap().expect("rows on demand");
        let mut made = Vec::new();
        for y in (0..whole.height).step_by(256) {
            made.extend(rows.rows(y, (y + 256).min(whole.height)).unwrap().data);
        }
        assert!(made.len() == whole.data.len() && made.iter().zip(&whole.data).all(|(a, b)| a.to_bits() == b.to_bits()), "highlight {} sharpen {}", o.highlight, o.capture_sharpen);
        println!("highlight {} sharpen {}: {} by {}, keeps {} MiB against {} MiB", o.highlight, o.capture_sharpen, whole.width, whole.height, rows.bytes() >> 20, (whole.data.len() * 4) >> 20);
    }
}

/// The kept RAW's sharpening state participates in admission before a
/// one-row render starts, and the refusal stays a memory error.
#[test]
fn a_kept_raw_admits_capture_sharpening_beside_its_samples() {
    use heeler_engine::banded;
    use heeler_graph::{Graph, Registry, Section};
    use std::collections::HashMap;
    let dir = tempfile::tempdir().unwrap();
    let path = mosaic_file(dir.path(), "rows-memory.dng");
    let rows = decode_rows_with(&path, RawSourceOpts::default()).unwrap().unwrap();
    assert!(rows.workspace().unwrap() > 0, "the sensor develop must sharpen");
    let (w, h) = rows.size();
    let mut graph = Graph::new("RAW admission");
    graph.add_node(Registry::builtin().instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    banded::with_row_sources(HashMap::from([("src".into(), rows.clone())]), || {
        let sources = HashMap::new();
        let ceiling = rows.bytes() + w * 16 * 2;
        heeler_engine::memory::with_budget(ceiling, || {
            assert!(matches!(banded::render_banded(&graph, &["src"], &sources, 1, &mut |_, _, _| Ok(())), Err(heeler_engine::EngineError::Memory(_))));
        });
        let estimate = banded::estimate_banded(&graph, &["src"], &sources, 1).unwrap();
        heeler_engine::memory::with_budget(estimate, || {
            banded::render_banded(&graph, &["src"], &sources, 1, &mut |_, _, _| Ok(())).unwrap();
        });
    });
    let whole = decode_any_with(&path, RawSourceOpts::default()).unwrap();
    let made = rows.rows(0, h).unwrap();
    assert!(made.data.iter().zip(&whole.data).all(|(a, b)| a.to_bits() == b.to_bits()));
}
