//! How long the app's decode takes per file under its develop choices:
//! the default, highlights clipped (one develop), capture sharpening off,
//! both. Run by hand in release, one path an argument.
use std::time::Instant;

fn main() {
    println!("file\tdefault ms\tclip ms\tno sharpen ms\tclip+no sharpen ms");
    for path in std::env::args().skip(1) {
        let p = std::path::Path::new(&path);
        let time = |opts: heeler_io::RawSourceOpts| {
            let t = Instant::now();
            let _ = heeler_io::decode_any_with(p, opts);
            t.elapsed().as_secs_f64() * 1000.0
        };
        let base = heeler_io::RawSourceOpts::default();
        let ext = p.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default();
        println!("{ext}\t{:.0}\t{:.0}\t{:.0}\t{:.0}", time(base), time(heeler_io::RawSourceOpts { highlight: 0, ..base }),
            time(heeler_io::RawSourceOpts { capture_sharpen: 0, ..base }), time(heeler_io::RawSourceOpts { highlight: 0, capture_sharpen: 0, ..base }));
    }
}
