//! How long LibRaw's develop takes per file, three ways: full size with
//! the default demosaic, full size with the linear one, and half size
//! (no demosaic). Run by hand in release, one path an argument.
use std::time::Instant;

fn main() {
    println!("file\tMP\tfull ms\tlinear ms\thalf ms");
    for path in std::env::args().skip(1) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let time = |opts: heeler_raw::DevelopOpts| {
            let t = Instant::now();
            let r = heeler_raw::decode_sensor_with(&bytes, opts);
            (t.elapsed().as_secs_f64() * 1000.0, r.ok().map(|s| s.width * s.height))
        };
        let base = heeler_raw::DevelopOpts::default();
        let (full, px) = time(base);
        let (linear, _) = time(heeler_raw::DevelopOpts { demosaic: 0, ..base });
        let (half, _) = time(heeler_raw::DevelopOpts { half_size: true, ..base });
        let name = std::path::Path::new(&path).extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        println!("{name}\t{:.0}\t{full:.0}\t{linear:.0}\t{half:.0}", px.unwrap_or(0) as f64 / 1e6);
    }
}
