//! Holds a raw file's unpacked mosaic to a reference DNG of the same
//! frame (a converter's uncompressed, not linear, DNG), sample by sample:
//! for a coding the corpus tests have no reference for, such as Nikon's
//! High Efficiency.
//! Both are unpacked here, each through its linearization table, and
//! compared over the part of the frame both image areas cover. Prints the
//! file's camera and area, its levels, the time its unpack took, the
//! sites compared, how many differ and the largest difference; exits 1 on
//! any difference or if the areas share nothing.
//!
//!   cargo run --release -p heeler-rawdec --example mosaicdiff -- FILE REFERENCE.dng
use heeler_rawdec::{develop, Opts, Plan};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = Opts { half_size: false, fixed_white: true, camera_wb: true, camera_matrix: true, highlight: 0, demosaic: -1, libraw_color: false };
    let open = |path: &str| {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let plan = Plan::new(&bytes, &opts).unwrap_or_else(|e| panic!("{path}: {e}"));
        let at = std::time::Instant::now();
        let cfa = develop::unpack(&bytes, &plan, None).unwrap_or_else(|e| panic!("{path}: {e}"));
        (plan, cfa, at.elapsed())
    };
    let (p, cfa, took) = open(&args[0]);
    let (q, reference, _) = open(&args[1]);
    let (top, left) = (p.top.max(q.top), p.left.max(q.left));
    let (bottom, right) = ((p.top + p.height).min(q.top + q.height), (p.left + p.width).min(q.left + q.width));
    let (mut differ, mut largest, mut sites) = (0u64, 0u32, 0u64);
    for r in top..bottom {
        let a = &cfa[(r - p.top) * p.width + (left - p.left)..][..right - left];
        let b = &reference[(r - q.top) * q.width + (left - q.left)..][..right - left];
        for (&x, &y) in a.iter().zip(b) {
            let d = (x as i32 - y as i32).unsigned_abs();
            differ += (d != 0) as u64;
            largest = largest.max(d);
        }
        sites += (right - left) as u64;
    }
    println!(
        "{} | area {} {} {} {} of {} {} | black {:?} white {} | reference area {} {} {} {} black {:?} white {} | unpack {:.0} ms | sites {} differ {} largest {}",
        p.dng.model,
        p.top,
        p.left,
        p.width,
        p.height,
        p.dng.width,
        p.dng.height,
        p.black,
        p.white,
        q.top,
        q.left,
        q.width,
        q.height,
        q.black,
        q.white,
        took.as_secs_f64() * 1e3,
        sites,
        differ,
        largest
    );
    if differ != 0 || sites == 0 {
        std::process::exit(1);
    }
}
