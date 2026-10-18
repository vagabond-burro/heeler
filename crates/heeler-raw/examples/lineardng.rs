//! Holds linear_dng.rs to LibRaw's develop, file by file, stage by stage.
//! Run by hand in release: lineardng <files...>
use heeler_raw::linear_dng::{blend, convert, libraw_stages, scale, LinearDng};
use heeler_raw::DevelopOpts;

fn main() {
    let mut tally = std::collections::BTreeMap::<String, usize>::new();
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).unwrap();
        let name = std::path::Path::new(&path).file_name().unwrap().to_string_lossy().to_string();
        for highlight in [0, 2] {
            let opts = DevelopOpts { highlight, ..DevelopOpts::default() };
            if let Some(why) = heeler_raw::linear_dng::declined_because(&bytes, opts).unwrap() {
                *tally.entry(format!("declined: {why}")).or_default() += 1;
                continue;
            }
            let dng = LinearDng::open(bytes.clone(), opts).unwrap().expect("open");
            let st = libraw_stages(&bytes, opts).unwrap();
            let data_max = dng.data_maximum().unwrap();
            let n = dng.numbers(data_max, highlight);
            let mut verdict = Vec::new();
            if data_max as u32 != st.maxima[1] { verdict.push(format!("data max {data_max} vs {}", st.maxima[1])); }
            if n.maximum != st.maxima[0] { verdict.push(format!("maximum {} vs {}", n.maximum, st.maxima[0])); }
            if n.pre_mul.map(f32::to_bits) != st.pre_mul.map(f32::to_bits) { verdict.push(format!("pre_mul {:?} vs {:?}", n.pre_mul, st.pre_mul)); }
            // The final develop, LibRaw's, to compare in the output's orientation.
            let full = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
            let (tw, th, across) = dng.tile_size();
            let (mut bad_scale, mut bad_blend, mut bad_final, mut bad_final_fused) = (0usize, 0usize, 0usize, 0usize);
            let (w, h) = (st.width, st.height);
            let flip = dng.flip();
            for t in 0..dng.tiles_count() {
                let tile = dng.tile(t).unwrap();
                let (r0, c0) = ((t / across) * th, (t % across) * tw);
                for r in 0..th {
                    for c in 0..tw {
                        let (y, x) = (r0 + r, c0 + c);
                        if y >= h || x >= w { continue; }
                        let i = (y * w + x) * 4;
                        let o = (r * tw + c) * 3;
                        let s = [scale(tile[o], n.scale_mul[0]), scale(tile[o + 1], n.scale_mul[1]), scale(tile[o + 2], n.scale_mul[2])];
                        if s[..] != st.scaled[i..i + 3] { bad_scale += 1; }
                        let b = if highlight == 2 { blend(s, n.clip, false) } else { s };
                        if b[..] != st.before_rgb[i..i + 3] { bad_blend += 1; }
                        let (oy, ox) = dng.to_output(y, x);
                        let fi = (oy * full.width + ox) * 3;
                        let want = &full.rgb[fi..fi + 3];
                        let lab = st.before_rgb[i..i + 3].try_into().unwrap();
                        let cv = convert(lab, &n.out_cam, false).map(|v| dng.curve(v));
                        if cv[..] != *want { bad_final += 1; }
                        let cf = convert(lab, &n.out_cam, true).map(|v| dng.curve(v));
                        if cf[..] != *want { bad_final_fused += 1; }
                    }
                }
            }
            verdict.push(format!("scale {bad_scale}, blend {bad_blend}, convert {bad_final} (fused {bad_final_fused})"));
            let key = if bad_scale + bad_blend == 0 && (bad_final == 0 || bad_final_fused == 0) && verdict.len() == 1 { format!("h{highlight} exact (convert {})", if bad_final == 0 { "plain" } else { "fused" }) } else { format!("h{highlight} {name}: {}", verdict.join("; ")) };
            println!("{name} h{highlight}: {}", verdict.join("; "));
            *tally.entry(key).or_default() += 1;
        }
    }
    for (k, v) in tally { println!("{v:>4}  {k}"); }
}
