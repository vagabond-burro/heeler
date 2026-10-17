//! One decode of one file, for /usr/bin/time -l to measure: `whole`
//! (decode_any_with) or `kept` (decode_rows_with, then every row made
//! once in bands of 256, as a streamed export reads it). Run by hand in
//! release: decodepeak <whole|kept> <file> [clip]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = std::path::Path::new(&args[2]);
    let opts = if args.get(3).map(String::as_str) == Some("clip") {
        heeler_io::RawSourceOpts { highlight: 0, ..Default::default() }
    } else {
        heeler_io::RawSourceOpts::default()
    };
    let t = std::time::Instant::now();
    match args[1].as_str() {
        "whole" => {
            let img = heeler_io::decode_any_with(path, opts).unwrap();
            println!("whole {}x{} in {:.0} ms", img.width, img.height, t.elapsed().as_secs_f64() * 1000.0);
        }
        _ => {
            let rows = heeler_io::decode_rows_with(path, opts).unwrap().expect("kept");
            let kept = t.elapsed();
            let (w, h) = rows.size();
            let mut y = 0;
            while y < h {
                let b = (y + 256).min(h);
                drop(rows.rows(y, b).unwrap());
                y = b;
            }
            println!("kept {w}x{h}: {} MiB kept, decode {:.0} ms, rows {:.0} ms", rows.bytes() >> 20, kept.as_secs_f64() * 1000.0, (t.elapsed() - kept).as_secs_f64() * 1000.0);
        }
    }
}
