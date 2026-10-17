//! How long a full-size X-Trans develop takes on 1, 4, 8 and 16 threads,
//! and whether each is the same as one thread's. Run by hand in release.
fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap();
        let mut first: Option<Vec<u16>> = None;
        for threads in [1usize, 4, 8, 16] {
            heeler_raw::set_xtrans_threads(threads);
            let t = std::time::Instant::now();
            let s = heeler_raw::decode_sensor(&bytes).unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            let same = first.get_or_insert_with(|| s.rgb.clone()) == &s.rgb;
            println!("{threads:>2} threads: {ms:.0} ms, same as one: {same}");
        }
    }
}
