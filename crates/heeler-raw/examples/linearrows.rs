//! linear_dng.rs's rows in bands against LibRaw's whole develop.
//! Run by hand in release: linearrows <files...>
use heeler_raw::linear_dng::LinearDng;
use heeler_raw::DevelopOpts;

fn main() {
    let (mut ok, mut all) = (0, 0);
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap();
        let name = std::path::Path::new(&path).file_name().unwrap().to_string_lossy().to_string();
        for highlight in [0, 2] {
            let opts = DevelopOpts { highlight, ..DevelopOpts::default() };
            let Some(dng) = LinearDng::open(bytes.clone(), opts).unwrap() else { continue };
            all += 1;
            let t = std::time::Instant::now();
            let n = dng.numbers(dng.data_maximum().unwrap(), highlight);
            let (w, h) = dng.size();
            let mut rows = Vec::with_capacity(w * h * 3);
            for y in (0..h).step_by(256) {
                rows.extend(dng.rows(&n, y, (y + 256).min(h)).unwrap());
            }
            let ours = t.elapsed();
            let t = std::time::Instant::now();
            let full = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
            let libraw = t.elapsed();
            let same = (full.width, full.height) == (w, h) && full.rgb == rows;
            if same { ok += 1; }
            println!("{name} h{highlight} flip {}: {} ({w}x{h}; ours {:.0} ms, LibRaw {:.0} ms)", dng.flip(), if same { "same" } else { "DIFFERS" }, ours.as_secs_f64() * 1e3, libraw.as_secs_f64() * 1e3);
        }
    }
    println!("{ok} of {all} the same");
}
