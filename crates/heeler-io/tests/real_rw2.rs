//! Opt-in diagnostics against a real RW2 file. Run with:
//!   HEELER_RW2=F:\...\file.RW2 cargo test -p heeler-io --features libraw --test real_rw2 -- --ignored --nocapture

use std::path::PathBuf;

#[test]
#[ignore]
fn diagnose_real_rw2() {
    let Some(path) = std::env::var_os("HEELER_RW2").map(PathBuf::from) else {
        eprintln!("HEELER_RW2 not set; skipping");
        return;
    };
    let bytes = std::fs::read(&path).unwrap();
    println!("file: {} ({} bytes)", path.display(), bytes.len());

    #[cfg(feature = "libraw")]
    {
        let t = std::time::Instant::now();
        match heeler_raw::decode_sensor(&bytes) {
            Ok(s) => println!("decode_sensor: OK {}x{} in {:?}", s.width, s.height, t.elapsed()),
            Err(e) => println!("decode_sensor: ERR {e}"),
        }
    }

    let t = std::time::Instant::now();
    match heeler_io::decode_bytes(&bytes) {
        Ok(img) => println!("decode_bytes(full): OK {}x{} in {:?}", img.width, img.height, t.elapsed()),
        Err(e) => println!("decode_bytes(full): ERR {e}"),
    }

    println!("raw_orientation: {}", heeler_io::raw_orientation(&bytes));

    // The EXIF, field by field. "it's not pulling any metadata from
    // my .RW2 files", and a synthetic header can only prove the parser reads
    // the shape of an RW2, not that it reads HIS RW2. This prints what it
    // actually found so the answer comes from the file rather than from me.
    let x = heeler_io::read_exif(&bytes);
    println!("exif.is_empty: {}", x.is_empty());
    println!("  camera:   {:?}", x.camera());
    println!("  lens:     {:?}", x.lens);
    println!("  shot_at:  {:?}", x.shot_at);
    println!("  iso:      {:?}", x.iso);
    println!(
        "  shutter:  {:?}",
        x.shutter.map(heeler_io::exif::format_shutter),
    );
    println!(
        "  aperture: {:?}",
        x.aperture.map(heeler_io::exif::format_aperture),
    );
    println!(
        "  focal:    {:?}",
        x.focal_length.map(heeler_io::exif::format_focal),
    );
    println!("  pixels:   {:?} x {:?}", x.width, x.height);
    // How the file announced itself, which is the thing that was wrong.
    println!(
        "  header:   {:?} magic {:?}",
        String::from_utf8_lossy(&bytes[..2]),
        u16::from_le_bytes([bytes[2], bytes[3]]),
    );

    let t = std::time::Instant::now();
    match heeler_io::decode_thumbnail(&path) {
        Ok(img) => println!("decode_thumbnail: OK {}x{} in {:?}", img.width, img.height, t.elapsed()),
        Err(e) => println!("decode_thumbnail: ERR {e}"),
    }

    let t = std::time::Instant::now();
    match heeler_io::decode_any(&path) {
        Ok(img) => println!("decode_any: OK {}x{} in {:?}", img.width, img.height, t.elapsed()),
        Err(e) => println!("decode_any: ERR {e}"),
    }

    let t = std::time::Instant::now();
    match heeler_io::decode_preview(&path) {
        Ok(img) => println!("decode_preview: OK {}x{} in {:?}", img.width, img.height, t.elapsed()),
        Err(e) => println!("decode_preview: ERR {e}"),
    }

    // Pixel sanity: real photographs have strongly correlated neighbors;
    // garbage (misread buffers) does not. Compare against the thumbnail,
    // which decodes through the ordinary JPEG path.
    let stats = |img: &heeler_engine::ImageBuf, label: &str| {
        let mut mean = 0.0f64;
        let mut ndiff = 0.0f64;
        let mut n = 0u64;
        for y in 0..img.height {
            for x in 0..img.width.saturating_sub(1) {
                let a = img.pixel(x, y);
                let b = img.pixel(x + 1, y);
                mean += a[0] as f64;
                ndiff += (a[0] - b[0]).abs() as f64;
                n += 1;
            }
        }
        println!(
            "{label}: mean {:.4}, neighbor diff {:.4} ({})",
            mean / n as f64,
            ndiff / n as f64,
            if ndiff / n as f64 > 0.15 { "LOOKS LIKE NOISE" } else { "plausible image" }
        );
    };
    if let Ok(img) = heeler_io::decode_preview(&path) {
        stats(&img, "decode_preview pixels");
    }
    if let Ok(img) = heeler_io::decode_any(&path) {
        stats(&img, "decode_any pixels");
    }
    if let Ok(img) = heeler_io::decode_thumbnail(&path) {
        stats(&img, "decode_thumbnail pixels");
    }

    // Source toggles must actually change the develop.
    if let (Ok(default_dev), Ok(no_wb), Ok(no_matrix)) = (
        heeler_io::decode_preview(&path),
        heeler_io::decode_preview_with(&path, heeler_io::RawSourceOpts { camera_wb: false, camera_matrix: true, highlight: 0, demosaic: -1, ..Default::default() }),
        heeler_io::decode_preview_with(&path, heeler_io::RawSourceOpts { camera_wb: true, camera_matrix: false, highlight: 0, demosaic: -1, ..Default::default() }),
    ) {
        let mean = |img: &heeler_engine::ImageBuf, c: usize| -> f64 {
            img.data.chunks(4).map(|p| p[c] as f64).sum::<f64>() / (img.width * img.height) as f64
        };
        println!(
            "toggle check R-mean: default {:.4}, wb-off {:.4}, matrix-off {:.4}",
            mean(&default_dev, 0),
            mean(&no_wb, 0),
            mean(&no_matrix, 0)
        );
    }

    // Optional visual dump for eyeballing decode output.
    if let Some(dir) = std::env::var_os("HEELER_RW2_DUMP").map(PathBuf::from) {
        let dump = |img: &heeler_engine::ImageBuf, name: &str| {
            let k = (img.width.max(img.height) / 640).max(1);
            let (w, h) = (img.width / k, img.height / k);
            let mut small = heeler_engine::ImageBuf::new(w, h);
            for y in 0..h {
                for x in 0..w {
                    small.set_pixel(x, y, img.pixel(x * k, y * k));
                }
            }
            let png = heeler_io::encode_png(&small).unwrap();
            std::fs::write(dir.join(name), png).unwrap();
        };
        if let Ok(img) = heeler_io::decode_any(&path) {
            dump(&img, "full.png");
        }
        if let Ok(img) = heeler_io::decode_preview(&path) {
            dump(&img, "half.png");
        }
        println!("dumped to {}", dir.display());
    }
}
