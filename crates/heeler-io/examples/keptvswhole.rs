//! decode_rows_with's rows, made in bands of 256, against decode_any_with,
//! bit for bit, under Blend and Clip. Run by hand in release:
//! keptvswhole <files...>
fn main() {
    let (mut same, mut all) = (0, 0);
    for path in std::env::args().skip(1) {
        let p = std::path::Path::new(&path);
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        for highlight in [2, 0] {
            let opts = heeler_io::RawSourceOpts { highlight, ..Default::default() };
            all += 1;
            let t = std::time::Instant::now();
            let Some(rows) = heeler_io::decode_rows_with(p, opts).unwrap() else { println!("{name} h{highlight}: not kept"); continue };
            let (w, h) = rows.size();
            let mut data = Vec::with_capacity(w * h * 4);
            for y in (0..h).step_by(256) {
                data.extend_from_slice(&rows.rows(y, (y + 256).min(h)).unwrap().data);
            }
            let kept = t.elapsed();
            let t = std::time::Instant::now();
            let whole = heeler_io::decode_any_with(p, opts).unwrap();
            let libraw = t.elapsed();
            let ok = (whole.width, whole.height) == (w, h) && whole.data.iter().zip(&data).all(|(a, b)| a.to_bits() == b.to_bits());
            if ok { same += 1; }
            println!("{name} h{highlight}: {} kept {} MiB, rows {:.0} ms, whole {:.0} ms", if ok { "same" } else { "DIFFERS" }, rows.bytes() >> 20, kept.as_secs_f64() * 1e3, libraw.as_secs_f64() * 1e3);
        }
    }
    println!("{same} of {all} the same");
}
