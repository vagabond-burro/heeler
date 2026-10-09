//! The rawler-vs-LibRaw comparison harness: the evidence the decoder
//! swap waits on. One file in, numbers and side-by-side JPEGs out.
//!
//!     cargo run -p heeler-io --features rawler,libraw --example rawdiff -- <raw files...>
//!
//! What the numbers mean: mean EV is the overall exposure difference
//! between the two developments (rendering intent, not an error);
//! after gain-matching, the per-channel ratios say whether the color
//! calibration agrees, and the residual says how differently the two
//! demosaics resolve detail. The JPEGs are for the eye that decides.

use std::path::Path;

use heeler_engine::ImageBuf;
use heeler_io::{decode_any, decode_rawler, encode_jpeg};

/// Nearest-sample shrink for the eyeball JPEGs; fidelity lives in the
/// numbers above, not here.
fn shrink(src: &ImageBuf, max_edge: usize) -> ImageBuf {
    let scale = (src.width.max(src.height) as f64 / max_edge as f64).max(1.0);
    let (w, h) = (
        (src.width as f64 / scale) as usize,
        (src.height as f64 / scale) as usize,
    );
    let mut out = ImageBuf::new(w.max(1), h.max(1));
    for y in 0..out.height {
        for x in 0..out.width {
            let sx = (x as f64 * scale) as usize;
            let sy = (y as f64 * scale) as usize;
            let px = src.pixel(sx.min(src.width - 1), sy.min(src.height - 1));
            out.set_pixel(x, y, px);
        }
    }
    out
}

fn mean_rgb(img: &ImageBuf) -> [f64; 3] {
    let mut sums = [0f64; 3];
    for px in img.data.chunks(4) {
        for c in 0..3 {
            sums[c] += px[c] as f64;
        }
    }
    let n = (img.width * img.height) as f64;
    [sums[0] / n, sums[1] / n, sums[2] / n]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: rawdiff <raw files...>");
        std::process::exit(2);
    }
    for arg in &args {
        let path = Path::new(arg);
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        println!("== {stem} ==");
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                println!("  unreadable: {e}");
                continue;
            }
        };
        let libraw = match decode_any(path) {
            Ok(img) => img,
            Err(e) => {
                println!("  libraw failed: {e}");
                continue;
            }
        };
        let Some(rawler_img) = decode_rawler(path, &bytes) else {
            println!("  rawler failed to decode");
            continue;
        };
        println!(
            "  dims  libraw {}x{}  rawler {}x{}",
            libraw.width, libraw.height, rawler_img.width, rawler_img.height
        );

        let ml = mean_rgb(&libraw);
        let mr = mean_rgb(&rawler_img);
        let lum = |m: [f64; 3]| 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
        let ev = (lum(mr) / lum(ml)).log2();
        println!("  mean EV rawler vs libraw: {ev:+.3}");
        println!(
            "  channel ratios (gain-matched): R {:.3}  G {:.3}  B {:.3}",
            mr[0] / ml[0] / 2f64.powf(ev),
            mr[1] / ml[1] / 2f64.powf(ev),
            mr[2] / ml[2] / 2f64.powf(ev),
        );

        // Residual after gain match, on the overlapping center (the two
        // paths may crop a few border pixels differently).
        if libraw.width.abs_diff(rawler_img.width) <= 16
            && libraw.height.abs_diff(rawler_img.height) <= 16
        {
            let w = libraw.width.min(rawler_img.width);
            let h = libraw.height.min(rawler_img.height);
            let gain = 2f32.powf(-ev as f32);
            let (mut sum, mut n) = (0f64, 0f64);
            for y in (0..h).step_by(4) {
                for x in (0..w).step_by(4) {
                    let a = libraw.pixel(x + (libraw.width - w) / 2, y + (libraw.height - h) / 2);
                    let b = rawler_img
                        .pixel(x + (rawler_img.width - w) / 2, y + (rawler_img.height - h) / 2);
                    for c in 0..3 {
                        sum += ((b[c] * gain - a[c]).abs()) as f64;
                        n += 1.0;
                    }
                }
            }
            println!("  mean |residual| after gain match: {:.4} (linear)", sum / n);
        } else {
            println!("  dims differ too much for a residual measure");
        }

        for (name, img) in [("libraw", &libraw), ("rawler", &rawler_img)] {
            let small = shrink(img, 1600);
            let out = format!("rawdiff_{stem}_{name}.jpg");
            match encode_jpeg(&small, 90) {
                Ok(jpeg) => {
                    let _ = std::fs::write(&out, jpeg);
                    println!("  wrote {out}");
                }
                Err(e) => println!("  encode failed: {e}"),
            }
        }
    }
}
