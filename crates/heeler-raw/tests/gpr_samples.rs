//! Every GoPro GPR under HEELER_GPR_SAMPLES (a directory, searched
//! recursively) develops: a picture of the size its header names, not
//! the flat field or noise a misread tile turns into. Ignored by
//! default since the files live outside the repository:
//!
//!     HEELER_GPR_SAMPLES=/path/to/gpr cargo test -p heeler-raw --test gpr_samples -- --ignored --nocapture

use std::path::{Path, PathBuf};

fn gprs(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        if p.is_dir() {
            gprs(&p, out);
        } else if !name.starts_with("._") && name.to_ascii_lowercase().ends_with(".gpr") {
            out.push(p);
        }
    }
}

#[test]
#[ignore]
fn every_sample_gpr_develops() {
    let dir = std::env::var("HEELER_GPR_SAMPLES").expect("set HEELER_GPR_SAMPLES");
    let mut files = Vec::new();
    gprs(Path::new(&dir), &mut files);
    files.sort();
    assert!(!files.is_empty(), "no .gpr under {dir}");
    for f in &files {
        let bytes = std::fs::read(f).unwrap();
        assert!(heeler_raw::is_gpr(&bytes), "{} is not read as a GPR", f.display());
        let (w, h) = heeler_raw::dimensions(&bytes).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let t = std::time::Instant::now();
        let img = heeler_raw::decode_sensor_half(&bytes).unwrap_or_else(|e| panic!("{}: {e}", f.display()));
        let n = img.rgb.len() as f64;
        let mean: Vec<f64> = (0..3).map(|c| img.rgb.iter().skip(c).step_by(3).map(|&v| v as f64).sum::<f64>() / (n / 3.0) / 65535.0).collect();
        // Neighboring pixels of a real picture agree far more than noise does.
        let rough = img.rgb.chunks_exact(3).zip(img.rgb.chunks_exact(3).skip(1)).map(|(a, b)| (a[1] as f64 - b[1] as f64).abs()).sum::<f64>() / (n / 3.0) / 65535.0;
        println!("{}  {w}x{h} -> {}x{}  mean {:.3} {:.3} {:.3}  step {:.4}  {:?}", f.display(), img.width, img.height, mean[0], mean[1], mean[2], rough, t.elapsed());
        // HEELER_GPR_OUT: a small sRGB-ish PPM of each, to look at.
        if let Ok(out) = std::env::var("HEELER_GPR_OUT") {
            let step = 4;
            let (ow, oh) = (img.width / step, img.height / step);
            let mut ppm = format!("P6 {ow} {oh} 255\n").into_bytes();
            for y in 0..oh {
                for x in 0..ow {
                    let i = ((y * step) * img.width + x * step) * 3;
                    for c in 0..3 {
                        let v = (img.rgb[i + c] as f64 / 65535.0 * 2.0).min(1.0).powf(1.0 / 2.2);
                        ppm.push((v * 255.0) as u8);
                    }
                }
            }
            let name = f.strip_prefix(&dir).unwrap().to_string_lossy().replace(['/', ' '], "_");
            std::fs::write(Path::new(&out).join(format!("{name}.ppm")), ppm).unwrap();
        }
        assert!(img.width * 2 >= w - 2 && img.height * 2 >= h - 2, "{}: developed smaller than its header", f.display());
        assert!(mean.iter().all(|m| *m > 0.002 && *m < 0.98), "{}: a flat field", f.display());
        assert!(rough < 0.08, "{}: noise, not a picture", f.display());
    }
}
