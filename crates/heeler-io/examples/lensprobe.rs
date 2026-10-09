//! Diagnostic: what lens name a file's EXIF carries and which lensfun
//! profile it matches. Run from the repo root on any image files:
//!
//!     cargo run -p heeler-io --example lensprobe -- photo.RW2 ...
//!
//! This is the tool for "why doesn't my lens get a profile" questions.
fn main() {
    let db = heeler_io::lensdb::LensDb::load_dir(std::path::Path::new("third_party/lensfun-db/db"));
    println!("db lenses: {}", db.lenses.len());
    for arg in std::env::args().skip(1) {
        let head = std::fs::read(&arg).unwrap();
        let exif = heeler_io::read_exif(&head[..head.len().min(1 << 20)]);
        let lens = exif.lens.unwrap_or_else(|| "<no lens in exif>".into());
        match db.match_lens(&lens) {
            Some(hit) => {
                println!("{arg}\n  exif: {lens}\n  matched: {} {} (calibration rows: {})", hit.maker, hit.model, hit.distortion.len());
                let focal = exif.focal_length.filter(|r| r.den != 0).map(|r| r.num as f32 / r.den as f32);
                let aperture = exif.aperture.filter(|r| r.den != 0).map(|r| r.num as f32 / r.den as f32);
                match hit.distortion_at(focal) {
                    Some(row) => println!("  distortion at {:?}mm: {} a={} b={} c={}", focal, row.model, row.a, row.b, row.c),
                    None => println!("  distortion at {focal:?}mm: none applicable"),
                }
                match hit.tca_at(focal) {
                    Some(t) => println!("  tca: vr={} br={} vb={} bb={}", t.vr, t.br, t.vb, t.bb),
                    None => println!("  tca: none ({} rows)", hit.tca.len()),
                }
                match hit.vignetting_at(focal, aperture) {
                    Some(k) => println!("  vignetting at f/{aperture:?}: k1={} k2={} k3={}", k[0], k[1], k[2]),
                    None => println!("  vignetting: none ({} rows)", hit.vignetting.len()),
                }
            }
            None => println!("{arg}\n  exif: {lens}\n  matched: none"),
        }
    }
}
