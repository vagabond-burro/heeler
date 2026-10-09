//! The M3.6 DNG verification harness: the three files, answered in
//! numbers instead of by eye.
//!
//!     cargo run -p heeler-io --features libraw --example dngprobe -- <files...>
//!
//! Why this exists rather than "open it and see": `decode_any` falls back
//! to the file's embedded JPEG preview whenever the sensor develop errors
//! OR fails `develop_looks_sane`, so a DNG whose decoder was never
//! compiled in still puts a photograph on screen. Every build during the
//! window when USE_JPEG was applied after compile() would have passed an
//! eyeball test on a Lossy DNG. This asks the decoder directly.
//!
//! What each line answers:
//!
//! - DECODE: did LibRaw produce a sensor develop at all. The whole test.
//! - dimensions: full sensor size vs what EXIF declares vs what the
//!   embedded preview would have been. A develop that matches the
//!   preview's size is the tell that you were looking at the preview.
//! - through decode_any: the size the app would actually display. If it
//!   disagrees with DECODE, the fallback fired.
//! - max / over 1.0: scene-linear headroom above white. For a RAW editor's
//!   HDR merge this is the question: the merge exists to hold highlights
//!   above scene white, and a max of 1.0 with nothing over it means the
//!   range did not survive the 16-bit decode path.
//! - jxl dng: the JPEG XL path (src/dng_jxl.rs), which answers for the
//!   files LibRaw declines. When this line and DECODE both appear, the
//!   two decoders are rendering the same photograph and their means
//!   should agree; when only this one appears, it is carrying the file
//!   alone.
//! - the highlight-mode table doubles as the M3.4 check: means that
//!   track each other prove reconstruction is exposure-invariant, and
//!   `over 1.0` climbing with the mode is reconstruction actually
//!   putting super-whites back for the tone profile to roll off.

use std::path::Path;

use heeler_engine::ImageBuf;
use heeler_io::{
    baked_exposure, decode_any_with, develop_looks_sane, extract_raw_preview, read_exif,
    RawSourceOpts,
};

/// Scene-linear stats, computed the way `sensor_to_imagebuf` does it:
/// u16 over 65535, times the headroom LibRaw withheld.
struct Stats {
    mean: f64,
    max: f32,
    over_one: f64,
}

/// The same numbers off an already-converted buffer, for comparing a
/// second decoder against the first.
fn buf_stats(img: &ImageBuf) -> Stats {
    let mut sum = 0f64;
    let mut max = 0f32;
    let mut over = 0u64;
    let mut n = 0u64;
    for px in img.data.chunks_exact(4) {
        for f in &px[..3] {
            sum += *f as f64;
            if *f > max {
                max = *f;
            }
            if *f > 1.0 {
                over += 1;
            }
            n += 1;
        }
    }
    let n = n.max(1) as f64;
    Stats { mean: sum / n, max, over_one: over as f64 / n * 100.0 }
}

fn stats(s: &heeler_raw::SensorImage) -> Stats {
    let gain = s.headroom.max(1.0);
    let mut sum = 0f64;
    let mut max = 0f32;
    let mut over = 0u64;
    for v in &s.rgb {
        let f = *v as f32 / 65535.0 * gain;
        sum += f as f64;
        if f > max {
            max = f;
        }
        if f > 1.0 {
            over += 1;
        }
    }
    let n = s.rgb.len().max(1) as f64;
    Stats { mean: sum / n, max, over_one: over as f64 / n * 100.0 }
}

fn probe(path: &Path) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    println!("== {name} ==");

    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            println!("  unreadable: {e}\n");
            return;
        }
    };
    println!("  {:.1} MB on disk", bytes.len() as f64 / 1_048_576.0);

    let exif = read_exif(&bytes);
    println!(
        "  camera: {}",
        exif.camera().unwrap_or_else(|| "(none declared)".into())
    );
    println!("  lens:   {}", exif.lens.clone().unwrap_or_else(|| "(none declared)".into()));
    match (exif.width, exif.height) {
        (Some(w), Some(h)) => println!("  EXIF declares {w} x {h}"),
        _ => println!("  EXIF declares no dimensions"),
    }
    if let Some(stops) = baked_exposure(&bytes) {
        println!("  NOTE: reads as a Heeler bake, offset {stops:+.2} EV (expected None here)");
    }

    let preview = extract_raw_preview(&bytes).and_then(|p| {
        image::load_from_memory(p).ok().map(|i| (i.width(), i.height()))
    });
    match preview {
        Some((w, h)) => println!("  embedded preview: {w} x {h} (what a fallback would show)"),
        None => println!("  embedded preview: none"),
    }

    // The question the whole exercise is about.
    let opts = heeler_raw::DevelopOpts::default();
    let full = heeler_raw::decode_sensor_with(&bytes, opts);
    match &full {
        Err(e) => {
            println!("  DECODE: FAILED -- {e:?}");
            println!("  (the app would silently show the embedded preview instead)");
        }
        Ok(s) => {
            let st = stats(s);
            println!("  DECODE: ok, {} x {}", s.width, s.height);
            println!(
                "  scene-linear: mean {:.4}, max {:.4}, {:.3}% of samples over 1.0",
                st.mean, st.max, st.over_one
            );
            if let (Some(w), Some(h)) = (exif.width, exif.height) {
                let close = |a: usize, b: u32| (a as i64 - b as i64).abs() <= 64;
                if !(close(s.width, w) && close(s.height, h))
                    && !(close(s.width, h) && close(s.height, w))
                {
                    println!("  WARNING: develop size disagrees with EXIF ({w} x {h})");
                }
            }
        }
    }

    // The JPEG XL path, which is ours rather than LibRaw's. Decoded once
    // here and reused below, since it is the expensive step on this file.
    let jxl = if heeler_io::is_jxl_dng(&bytes) {
        let started = std::time::Instant::now();
        let result = heeler_io::decode_jxl_dng(&bytes);
        let took = started.elapsed();
        match &result {
            Err(e) => println!("  jxl dng: FAILED -- {e}"),
            Ok(img) => {
                let st = buf_stats(img);
                println!(
                    "  jxl dng: ok, {} x {} in {:.2}s -- mean {:.4}, max {:.4}, {:.3}% over 1.0",
                    img.width,
                    img.height,
                    took.as_secs_f64(),
                    st.mean,
                    st.max,
                    st.over_one
                );
            }
        }
        result.ok()
    } else {
        None
    };

    // What the app would actually put on screen, fallbacks and all.
    match decode_any_with(path, RawSourceOpts::default()) {
        Err(e) => println!("  through decode_any: FAILED -- {e}"),
        Ok(img) => {
            let sane = develop_looks_sane(&img);
            print!("  through decode_any: {} x {}", img.width, img.height);
            // Two decoders can legitimately answer here, so a size that
            // does not match LibRaw is only a fallback if the JPEG XL
            // path was not the one that served it.
            let jxl_served =
                jxl.as_ref().is_some_and(|j| j.width == img.width && j.height == img.height);
            match &full {
                Ok(s) if s.width == img.width && s.height == img.height => {
                    println!(" (the real develop)")
                }
                _ if jxl_served => println!(" (the JPEG XL develop, ours not LibRaw's)"),
                _ => println!("  <-- FELL BACK, this is not the develop"),
            }
            if !sane {
                println!("  develop_looks_sane: NO (mosaic-looking; this is what triggers the fallback)");
            }
        }
    }

    // The second decoder, when it is compiled in. It matters most
    // exactly where LibRaw failed: rawler reads DNG 1.7's JPEG XL
    // compression (52546) through pure-Rust jxl_oxide, which LibRaw
    // only ever does through the DNG SDK we do not build.
    #[cfg(feature = "rawler")]
    match heeler_io::decode_rawler(path, &bytes) {
        // decode_rawler returns an Option, so ask rawler again for the
        // reason it will actually name.
        None => match rawler::decode_file(path) {
            Err(e) => println!("  rawler: declined this file -- {e}"),
            Ok(_) => println!("  rawler: decoded, but the develop stage declined it"),
        },
        Some(img) => {
            let st = buf_stats(&img);
            println!(
                "  rawler: ok, {} x {} -- mean {:.4}, max {:.4}, {:.3}% over 1.0",
                img.width, img.height, st.mean, st.max, st.over_one
            );
        }
    }

    // Highlight modes: exposure invariance, and whether reconstruction
    // actually returns anything above white. Half size to keep it quick;
    // the ratios are what matter, not the resolution.
    if full.is_ok() {
        println!("  highlight modes (half size):");
        for (label, highlight) in [("clip", 0), ("blend", 2), ("rebuild", 5)] {
            let o = heeler_raw::DevelopOpts { half_size: true, highlight, ..opts };
            match heeler_raw::decode_sensor_with(&bytes, o) {
                Ok(s) => {
                    let st = stats(&s);
                    println!(
                        "    {label:<8} mean {:.4}  max {:.4}  over 1.0 {:.3}%  (headroom x{:.4})",
                        st.mean, st.max, st.over_one, s.headroom
                    );
                }
                Err(e) => println!("    {label:<8} FAILED -- {e:?}"),
            }
        }
    }
    println!();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: dngprobe <files...>");
        std::process::exit(2);
    }

    // The build-time probes. These are what lied last time, so they are
    // reported next to the results they are supposed to predict rather
    // than trusted.
    println!(
        "build says: libjpeg {} (lossy DNG), zlib {} (deflate / HDR-merged DNG), LibRaw {}\n",
        if heeler_raw::JPEG_LINKED { "linked" } else { "MISSING" },
        if heeler_raw::ZLIB_LINKED { "linked" } else { "MISSING" },
        heeler_raw::LIBRAW_VERSION,
    );

    for arg in &args {
        probe(Path::new(arg));
    }
}
