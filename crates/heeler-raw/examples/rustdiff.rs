//! heeler-rawdec's develop of each file against LibRaw's, stage by stage:
//! the unpacked mosaic (to the bit), the mosaic after black and white
//! balance (to the bit), and the developed output, full size and half,
//! under Clip and Blend (to the bit too on Apple's arm64 build; elsewhere
//! the float arithmetic can differ in the last place, and the summary
//! says by how much). One line a file, then a tally. Paths, or the DNGs
//! of the corpus at HEELER_RAW_CORPUS (folders separated as PATH's are).
//!
//!   cargo run --release -p heeler-raw --example rustdiff -- [--quick] [paths]
//!
//! --quick compares the output of the full-size Clip develop only.
//! --where prints, for the full-size Clip develop, how many differing
//! pixels lie in the border band and inside, and the first few.
//! --any takes every file the develop's rules accept, not only the
//! verified cameras'.
//! --own develops with the plan's own levels and balance (the shipped
//! develop's), only the matrix LibRaw's.
use heeler_raw::DevelopOpts;
use heeler_rawdec::Opts;

fn files(args: &[String]) -> Vec<std::path::PathBuf> {
    let paths: Vec<_> = args.iter().filter(|a| !a.starts_with("--")).map(std::path::PathBuf::from).collect();
    if !paths.is_empty() {
        return paths;
    }
    let roots = std::env::var_os("HEELER_RAW_CORPUS").expect("paths or HEELER_RAW_CORPUS");
    let mut out = Vec::new();
    let mut stack: Vec<_> = std::env::split_paths(&roots).collect();
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if name.to_ascii_uppercase().ends_with(".DNG") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Differences between two develops' samples.
#[derive(Default, Debug)]
pub struct Diff {
    pub samples: usize,
    pub differ: usize,
    pub over_1pct: usize,
    pub max: u32,
    pub mean: f64,
    pub p999: u32,
    pub psnr: f64,
}

fn diff(a: &[u16], b: &[u16]) -> Diff {
    let mut hist = vec![0usize; 65536];
    let (mut sum, mut sq) = (0f64, 0f64);
    for (&x, &y) in a.iter().zip(b) {
        let d = (x as i32 - y as i32).unsigned_abs();
        hist[d as usize] += 1;
        sum += d as f64;
        sq += (d as f64) * (d as f64);
    }
    let n = a.len().max(1);
    let mut acc = 0;
    let mut p999 = 0;
    for (d, &k) in hist.iter().enumerate() {
        acc += k;
        if acc as f64 >= 0.999 * n as f64 {
            p999 = d as u32;
            break;
        }
    }
    let mse = sq / n as f64;
    Diff {
        samples: n,
        differ: n - hist[0],
        over_1pct: hist[656..].iter().sum(),
        max: hist.iter().rposition(|&k| k > 0).unwrap_or(0) as u32,
        mean: sum / n as f64,
        p999,
        psnr: if mse == 0.0 { f64::INFINITY } else { 10.0 * (65535.0f64 * 65535.0 / mse).log10() },
    }
}

fn opts_of(o: DevelopOpts) -> Opts {
    Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic, libraw_color: true }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let quick = args.iter().any(|a| a == "--quick");
    let wher = args.iter().any(|a| a == "--where");
    let own = args.iter().any(|a| a == "--own");
    if args.iter().any(|a| a == "--any") {
        heeler_rawdec::set_verified_only(false);
    }
    // heeler-raw's own entry points answer for LibRaw here.
    #[cfg(feature = "rust-decoder")]
    heeler_raw::rust_path::set_enabled(false);
    let mut tally: std::collections::BTreeMap<String, usize> = Default::default();
    for path in files(&args) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let name = path.to_string_lossy().into_owned();
        let base = DevelopOpts::default();
        let plan = match heeler_rawdec::plan(&bytes, &opts_of(base)) {
            Ok(p) => p,
            Err(e) => {
                println!("{name}: declined: {e}");
                *tally.entry(format!("declined: {e}")).or_default() += 1;
                continue;
            }
        };
        let mut notes = Vec::new();
        let mut exact = true;
        // The develop's matrix is not what this compares (LibRaw's own
        // tables can round a camera's matrix apart from the file's): the
        // outputs below are developed with LibRaw's.
        let libraw_matrix = heeler_raw::linear_dng::libraw_facts(&bytes, base).ok().map(|f| f.rgb_cam.map(|r| [r[0], r[1], r[2]]));
        // LibRaw's black and white levels too, for formats whose levels the
        // develop reads its own way (a DNG's are the same either way).
        // --own keeps the plan's levels and balance (the shipped develop's),
        // LibRaw's matrix only.
        let numbered = if own { plan.clone() } else { heeler_raw::with_libraw_numbers(&bytes, &plan).unwrap_or_else(|_| plan.clone()) };
        // An image of three samples a pixel has no mosaic: its outputs are
        // what is compared.
        if !quick && !plan.three() {
            // The develop matrix, to the bit.
            if let Ok(f) = heeler_raw::linear_dng::libraw_facts(&bytes, base) {
                let ulps: Vec<i64> = (0..9).map(|k| (plan.rgb_cam[k / 3][k % 3].to_bits() as i64 - f.rgb_cam[k / 3][k % 3].to_bits() as i64).abs()).collect();
                if ulps.iter().any(|&u| u != 0) {
                    notes.push(format!("rgb_cam ulps {ulps:?}"));
                }
                // The develop's own levels, which the outputs below do
                // not use: the black measured on the masked border, and
                // the white level and balance.
                let own_black = if plan.dng.border_black {
                    heeler_rawdec::develop::unpack_measuring_black(&bytes, &plan, None).ok().map(|(_, b)| b)
                } else {
                    let at = |r: usize, c: usize| plan.black.get((r % plan.black_rows.max(1)) * plan.black_cols.max(1) + c % plan.black_cols.max(1)).copied().unwrap_or(0);
                    Some([at(0, 0), at(0, 1), at(1, 0), at(1, 1)])
                };
                if !plan.dng.is_dng() {
                    if let (Some(own), Ok(theirs)) = (own_black, heeler_raw::libraw_black_unpacked_8x8(&bytes)) {
                        let theirs = [theirs[0][0], theirs[0][1], theirs[1][0], theirs[1][1]];
                        if own != theirs {
                            notes.push(format!("own black {own:?} vs {theirs:?}"));
                            *tally.entry("own black differs (not in the outputs)".into()).or_default() += 1;
                        }
                    }
                }
                // LibRaw's white once it has unpacked (a few formats' settle
                // only then), and its balance as ratios to green (formats
                // state it in different units).
                let unpacked_white = heeler_raw::linear_dng::libraw_facts_unpacked(&bytes, base).map_or(f.maximum, |u| u.maximum);
                let ratio = |m: &[f32]| [m[0] / m[1], m[2] / m[1]];
                let (mine, theirs) = (ratio(&plan.cam_mul), ratio(&f.cam_mul));
                let balance_differs = f.cam_mul[..3].iter().all(|&v| v > 0.0) && mine.iter().zip(&theirs).any(|(a, b)| (a - b).abs() > 1e-4 * b.abs());
                if plan.white != unpacked_white || balance_differs {
                    notes.push(format!("own white {} vs {}, balance {:?} vs {:?}", plan.white, unpacked_white, plan.cam_mul, f.cam_mul));
                    *tally.entry("own white or balance differs (not in the outputs)".into()).or_default() += 1;
                }
            }
            // The unpacked mosaic.
            match heeler_raw::libraw_mosaic(&bytes) {
                Ok((w, h, theirs)) => {
                    let mine = match heeler_rawdec::develop::unpack(&bytes, &plan, None) {
                        Ok(m) => m,
                        Err(e) => {
                            println!("{name} unpack: {e}");
                            *tally.entry(format!("unpack failed: {e}")).or_default() += 1;
                            continue;
                        }
                    };
                    if (w, h) != (plan.width, plan.height) || mine != theirs {
                        exact = false;
                        notes.push(format!("mosaic {}x{} vs {w}x{h}, {} samples differ", plan.width, plan.height, mine.iter().zip(&theirs).filter(|(a, b)| a != b).count()));
                    }
                }
                Err(e) => notes.push(format!("libraw mosaic: {e}")),
            }
            // After black and white balance, Clip and Blend.
            for highlight in [0, 2] {
                let o = DevelopOpts { highlight, ..base };
                let stages = heeler_raw::linear_dng::libraw_stages(&bytes, o).unwrap();
                let mut mine = heeler_rawdec::develop::unpack(&bytes, &plan, None).unwrap();
                heeler_rawdec::develop::fill_zeros(&mut mine, &plan);
                let numbered = heeler_raw::with_libraw_balance(&bytes, &numbered, o);
                let max = heeler_rawdec::develop::subtract_black(&mut mine, &numbered);
                let n = heeler_rawdec::develop::numbers(&numbered, &opts_of(o), max);
                heeler_rawdec::develop::scale_mosaic(&mut mine, &plan, &n);
                let theirs: Vec<u16> = stages.scaled.chunks_exact(4).map(|p| *p.iter().max().unwrap()).collect();
                let bad = mine.iter().zip(&theirs).filter(|(a, b)| a != b).count();
                if bad > 0 || stages.maxima[2] != n.maximum || stages.maxima[1] != max as u32 {
                    exact = false;
                    let first: Vec<String> = mine.iter().zip(&theirs).enumerate().filter(|(_, (a, b))| a != b).take(4).map(|(i, (a, b))| {
                        let (r, c) = (i / plan.width, i % plan.width);
                        format!("({r},{c}) site {} loaded {} -> {a} vs {b}", plan.pattern[r & 1][c & 1], stages.loaded[i * 4..i * 4 + 4].iter().max().unwrap())
                    }).collect();
                    notes.push(format!("scaled h{highlight}: {bad} differ {} scale_mul {:?}, max {} vs {} data_max {} vs {} pre_mul {:?} vs {:?}", first.join(" "), n.scale_mul, n.maximum, stages.maxima[2], max, stages.maxima[1], n.pre_mul, stages.pre_mul));
                }
            }
        }
        // The output.
        let cases: &[(bool, i32)] = if quick { &[(false, 0)] } else { &[(true, 0), (true, 2), (false, 0), (false, 2)] };
        let mut full_worst: Option<Diff> = None;
        for &(half, highlight) in cases {
            let o = DevelopOpts { half_size: half, highlight, ..base };
            let theirs = heeler_raw::decode_sensor_with(&bytes, o).unwrap();
            let mut with = numbered.clone();
            if let Some(m) = libraw_matrix {
                with.rgb_cam = m;
            }
            if !own {
                with = heeler_raw::with_libraw_balance(&bytes, &with, o);
            }
            let (mine, _) = match heeler_rawdec::develop::develop_with(&bytes, &with, &opts_of(o), None) {
                Ok(m) => m,
                Err(e) => {
                    notes.push(format!("develop {half} h{highlight}: {e}"));
                    exact = false;
                    continue;
                }
            };
            if (mine.width, mine.height) != (theirs.width, theirs.height) {
                notes.push(format!("size {}x{} vs {}x{} (half {half})", mine.width, mine.height, theirs.width, theirs.height));
                exact = false;
                continue;
            }
            if (mine.headroom - theirs.headroom).abs() > 1e-6 {
                notes.push(format!("headroom {} vs {}", mine.headroom, theirs.headroom));
            }
            let d = diff(&mine.rgb, &theirs.rgb);
            if wher && !half && highlight == 0 {
                let (w, h) = (mine.width, mine.height);
                let (mut edge, mut inside, mut first) = (0, 0, Vec::new());
                for y in 0..h {
                    for x in 0..w {
                        let i = (y * w + x) * 3;
                        if mine.rgb[i..i + 3] != theirs.rgb[i..i + 3] {
                            if y < 5 || x < 5 || y + 5 >= h || x + 5 >= w { edge += 1 } else { inside += 1 }
                            if first.len() < 6 {
                                first.push(format!("({y},{x}) {:?} vs {:?}", &mine.rgb[i..i + 3], &theirs.rgb[i..i + 3]));
                            }
                        }
                    }
                }
                notes.push(format!("where: border {edge} inside {inside} {}", first.join(" ")));
            }
            if half {
                if d.differ > 0 {
                    exact = false;
                    notes.push(format!("half h{highlight}: {} of {} differ, max {}", d.differ, d.samples, d.max));
                }
            } else {
                notes.push(format!("full h{highlight}: differ {:.3}% >1% {:.4}% p99.9 {} max {} mean {:.3} psnr {:.1}", 100.0 * d.differ as f64 / d.samples as f64, 100.0 * d.over_1pct as f64 / d.samples as f64, d.p999, d.max, d.mean, d.psnr));
                if full_worst.as_ref().is_none_or(|w| d.psnr < w.psnr) {
                    full_worst = Some(d);
                }
            }
        }
        *tally.entry(if exact { "exact to demosaic".to_string() } else { "NOT exact".to_string() }).or_default() += 1;
        println!("{name} [{} {}] {}", plan.dng.make, plan.dng.model, notes.join(" | "));
    }
    println!();
    for (k, v) in tally {
        println!("{v:5}  {k}");
    }
}
