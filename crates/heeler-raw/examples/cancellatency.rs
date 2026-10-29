//! How long the Rust develop takes to stop once canceled partway: each
//! file developed once whole (its time T), then canceled at a tenth, a
//! third, a half and seven tenths of T, the time from the cancel to the
//! develop's return measured each time. Run in release:
//!
//!   cargo run --release -p heeler-raw --features rust-decoder --example cancellatency -- [--any] <files>
//!
//! One line a file: T, the slowest stop and the share of T it came at.
//! A develop that ends before its cancel is not counted.
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use heeler_rawdec::Opts;

fn main() {
    let mut files = Vec::new();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--any" => heeler_rawdec::set_verified_only(false),
            _ => files.push(std::path::PathBuf::from(arg)),
        }
    }
    let o = Opts { half_size: false, fixed_white: false, camera_wb: true, camera_matrix: true, highlight: 2, demosaic: -1, libraw_color: false };
    let mut worst = (Duration::ZERO, String::new());
    for path in &files {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let Ok(plan) = heeler_rawdec::Plan::new(&bytes, &o) else { continue };
        let t0 = Instant::now();
        if heeler_rawdec::develop::develop_with(&bytes, &plan, &o, None).is_err() {
            continue;
        }
        let whole = t0.elapsed();
        let mut slowest = (Duration::ZERO, 0.0);
        for share in [0.1, 0.33, 0.5, 0.7] {
            let stop = AtomicBool::new(false);
            let at = whole.mul_f64(share);
            let (done, set) = std::thread::scope(|s| {
                let stop = &stop;
                let setter = s.spawn(move || {
                    std::thread::sleep(at);
                    stop.store(true, Ordering::Relaxed);
                    Instant::now()
                });
                let r = heeler_rawdec::develop::develop_with(&bytes, &plan, &o, Some(stop));
                let end = Instant::now();
                let set = setter.join().unwrap();
                (r.map(|_| ()).err().map(|e| (e, end)), set)
            });
            if let Some((heeler_rawdec::Error::Canceled, end)) = done {
                let took = end.saturating_duration_since(set);
                if took > slowest.0 {
                    slowest = (took, share);
                }
            }
        }
        println!("{}: whole {:.0} ms, stopped within {:.1} ms (canceled at {:.0}%)", path.display(), whole.as_secs_f64() * 1e3, slowest.0.as_secs_f64() * 1e3, slowest.1 * 100.0);
        if slowest.0 > worst.0 {
            worst = (slowest.0, path.display().to_string());
        }
    }
    println!("slowest stop: {:.1} ms, {}", worst.0.as_secs_f64() * 1e3, worst.1);
}
