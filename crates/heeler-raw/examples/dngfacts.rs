//! heeler-rawdec's reading of each CFA DNG's tags against what LibRaw
//! read when it opened the file: sizes, margins, CFA colors, black and
//! white levels, the camera's white balance, orientation and the
//! develop matrix under several readings of the profile tags. Prints
//! one line a file that differs anywhere, and a tally. Paths, or the
//! corpus at HEELER_RAW_CORPUS with no paths.
use heeler_rawdec::color;
use heeler_rawdec::dng::Dng;

fn files() -> Vec<std::path::PathBuf> {
    let args: Vec<_> = std::env::args().skip(1).map(std::path::PathBuf::from).collect();
    if !args.is_empty() {
        return args;
    }
    let root = std::env::var_os("HEELER_RAW_CORPUS").expect("paths or HEELER_RAW_CORPUS");
    let mut out = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(root)];
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

fn main() {
    let mut tally: std::collections::BTreeMap<&str, usize> = Default::default();
    let mut n = 0;
    for path in files() {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(d) = Dng::parse(&bytes) else { continue };
        let Ok(f) = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()) else {
            *tally.entry("libraw failed").or_default() += 1;
            continue;
        };
        n += 1;
        let mut diffs: Vec<String> = Vec::new();
        let (top, left, bottom, right) = d.active;
        if (f.raw_width as usize, f.raw_height as usize) != (d.width, d.height) {
            diffs.push(format!("raw size {}x{} vs {}x{}", f.raw_width, f.raw_height, d.width, d.height));
        }
        if (f.top_margin as usize, f.left_margin as usize, f.width as usize, f.height as usize) != (top, left, right - left, bottom - top) {
            diffs.push(format!("area t{} l{} {}x{} vs t{top} l{left} {}x{}", f.top_margin, f.left_margin, f.width, f.height, right - left, bottom - top));
        }
        // LibRaw's colors at the image's (row, col), its second green as 1.
        let fc = |r: u32, c: u32| ((f.filters >> ((((r << 1) & 14) | (c & 1)) << 1)) & 3) as u8;
        let mut cfa_ok = true;
        for r in 0..2u32 {
            for c in 0..2u32 {
                let ours = d.color_at(f.top_margin as usize + r as usize, f.left_margin as usize + c as usize);
                let theirs = if fc(r, c) == 3 { 1 } else { fc(r, c) };
                cfa_ok &= ours == theirs;
            }
        }
        if !cfa_ok {
            diffs.push(format!("cfa {:?} filters {:08x}", d.cfa, f.filters));
        }
        // Black at each of the first 8 by 8 pixels of the active area.
        let theirs_black = heeler_raw::libraw_black_8x8(&bytes).unwrap();
        let ours_black = |r: usize, c: usize| {
            let (r, c) = (r + top, c + left);
            let (br, bc) = ((r - top) % d.black_dim.0, (c - left) % d.black_dim.1);
            d.black.get(br * d.black_dim.1 + bc).copied().unwrap_or(d.black[0]) + d.black_delta_h.get(c - left).copied().unwrap_or(0.0) + d.black_delta_v.get(r - top).copied().unwrap_or(0.0)
        };
        let mut worst = 0.0f64;
        for r in 0..8 {
            for c in 0..8 {
                worst = worst.max((ours_black(r, c) - theirs_black[r][c] as f64).abs());
            }
        }
        if worst > 0.0 {
            let kind = if !d.black_delta_h.is_empty() || !d.black_delta_v.is_empty() { "black deltas" } else if d.black.iter().any(|b| b.fract() != 0.0) { "black fraction" } else { "black" };
            diffs.push(format!("{kind}: worst {worst} ours {:?} dim {:?} libraw {:?}", &d.black[..d.black.len().min(4)], d.black_dim, &theirs_black[0][..4]));
        }
        if (d.white[0] - f.maximum as f64).abs() > 0.5 {
            diffs.push(format!("white {:?} vs maximum {} (lin {})", d.white, f.maximum, d.linearization.as_ref().map_or(0, |l| l.len())));
        }
        // White balance: LibRaw's cam_mul over its green, ours 1/neutral.
        if let Some(n) = &d.as_shot_neutral {
            if n.len() >= 3 && f.cam_mul[1] > 0.0 {
                let ours = [n[1] / n[0], 1.0, n[1] / n[2]];
                let theirs = [f.cam_mul[0] / f.cam_mul[1], 1.0, f.cam_mul[2] / f.cam_mul[1]];
                if (0..3).any(|i| (ours[i] - theirs[i] as f64).abs() > 1e-4 * ours[i].abs().max(1.0)) {
                    diffs.push(format!("wb {ours:?} vs {theirs:?}"));
                }
            }
        } else {
            diffs.push(format!("no AsShotNeutral (xy {:?}); cam_mul {:?}", d.as_shot_white_xy, f.cam_mul));
        }
        let flip = if (1..=8).contains(&d.orientation) { [0, 0, 1, 3, 2, 4, 6, 7, 5][d.orientation as usize] } else { 0 };
        if flip != f.flip {
            diffs.push(format!("flip {} from orientation {} vs {}", flip, d.orientation, f.flip));
        }
        // Which reading of the matrices LibRaw developed with.
        let theirs: Vec<f64> = (0..3).flat_map(|i| (0..3).map(move |j| (i, j))).map(|(i, j)| f.rgb_cam[i][j] as f64).collect();
        let reading = |m: &Option<Vec<f64>>, cc: &Option<Vec<f64>>, ab: bool| -> Option<f64> {
            let mut cm = color::as3(m.as_deref()?)?;
            if let Some(cc) = cc.as_deref().and_then(color::as3) {
                cm = color::mul3(&cc, &cm);
            }
            if ab {
                if let Some(a) = d.analog_balance.as_deref().filter(|a| a.len() >= 3) {
                    cm = color::mul3(&[[a[0], 0.0, 0.0], [0.0, a[1], 0.0], [0.0, 0.0, a[2]]], &cm);
                }
            }
            let (m, _) = color::srgb_from_camera(&cm)?;
            Some((0..9).map(|k| (m[k / 3][k % 3] - theirs[k]).abs()).fold(0.0, f64::max))
        };
        let mut readings = Vec::new();
        for (slot, name) in [(0, "CM1"), (1, "CM2"), (2, "CM3")] {
            for (cc, ccname) in [(&None, ""), (&d.camera_calibration[slot], "+CC")] {
                for ab in [false, true] {
                    if let Some(e) = reading(&d.color_matrix[slot], cc, ab) {
                        readings.push((format!("{name}{ccname}{}", if ab { "+AB" } else { "" }), e));
                    }
                }
            }
        }
        let best = readings.iter().filter(|r| r.1 < 2e-5).map(|r| r.0.clone()).collect::<Vec<_>>();
        let key: &'static str = Box::leak(format!("matrix {} illum {:?}", if best.is_empty() { "NONE".to_string() } else { best.join("|") }, d.illuminant).into_boxed_str());
        *tally.entry(key).or_default() += 1;
        if best.is_empty() {
            diffs.push(format!("matrix: no reading matches; {:?}", readings.iter().map(|r| format!("{}={:.2e}", r.0, r.1)).collect::<Vec<_>>()));
        }
        let class = format!("c{} {}b", d.compression, d.bits);
        let rel = path.to_string_lossy().into_owned();
        if diffs.is_empty() {
            *tally.entry("all equal").or_default() += 1;
        } else {
            for dd in &diffs {
                let k: &'static str = Box::leak(dd.split(':').next().unwrap_or("").split(' ').next().unwrap_or("").to_string().into_boxed_str());
                *tally.entry(k).or_default() += 1;
            }
            println!("{rel} [{class}] {}", diffs.join(" | "));
        }
    }
    println!("\n{n} CFA DNGs");
    for (k, v) in tally {
        println!("{v:5}  {k}");
    }
}
