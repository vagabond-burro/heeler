//! The raw decode benchmark: wall time from a file's bytes to the
//! SensorImage Heeler develops, per file, split into open, unpack and
//! develop, as the median of several runs. Run in release:
//!
//!   cargo run --release -p heeler-raw --example rawbench -- [options] [paths]
//!
//! With no paths it walks the corpus at HEELER_RAW_CORPUS (a tree of
//! maker/camera/file, the sample archive's layout), skipping AppleDouble
//! `._` files and the manifest. Options:
//!
//!   --decoder libraw|rust   which develop to time (libraw); rust needs
//!                           the rust-decoder feature and skips the
//!                           files that path declines
//!   --runs N                timed runs a file, after one untimed (3)
//!   --half                  half-size develops instead of full
//!   --only TEXT             only files whose corpus path contains TEXT
//!                           (repeatable; any match keeps the file)
//!   --ext ARW,DNG           only these extensions, any case
//!   --per-camera N          at most N files a camera folder
//!   --csv FILE              one row a file, written as it goes
//!   --summarize FILE        no timing: the per-format and per-camera
//!                           totals of a CSV this harness wrote
//!   --compare BASE NEW      no timing: NEW against BASE, file by file
//!                           where both decoded, per format and camera
//!
//! The format column says more than the extension where the extension
//! hides several decoders: a DNG is classed by its raw image's
//! compression and photometric interpretation (DNG-LJ92-CFA,
//! DNG-LJ92-Linear, DNG-Deflate, DNG-LossyJPEG, DNG-JXL, DNG-Uncompressed).
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use heeler_raw::{DevelopOpts, StageTimes};

struct Args {
    decoder: String,
    runs: usize,
    half: bool,
    only: Vec<String>,
    ext: Vec<String>,
    per_camera: usize,
    csv: Option<PathBuf>,
    paths: Vec<PathBuf>,
}

fn main() {
    let mut a = Args { decoder: "libraw".into(), runs: 3, half: false, only: Vec::new(), ext: Vec::new(), per_camera: usize::MAX, csv: None, paths: Vec::new() };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut value = || it.next().unwrap_or_else(|| panic!("{arg} wants a value"));
        match arg.as_str() {
            "--decoder" => a.decoder = value(),
            "--runs" => a.runs = value().parse().expect("--runs N"),
            "--half" => a.half = true,
            "--only" => a.only.push(value()),
            "--ext" => a.ext.extend(value().split(',').map(|e| e.trim().to_ascii_uppercase())),
            "--per-camera" => a.per_camera = value().parse().expect("--per-camera N"),
            "--csv" => a.csv = Some(value().into()),
            "--summarize" => return summarize(&read_csv(Path::new(&value()))),
            "--compare" => {
                let base = value();
                let new = value();
                return compare(&read_csv(Path::new(&base)), &read_csv(Path::new(&new)));
            }
            _ => a.paths.push(arg.into()),
        }
    }
    let root = std::env::var_os("HEELER_RAW_CORPUS").map(PathBuf::from);
    let files = if a.paths.is_empty() {
        let Some(root) = root.as_deref() else {
            eprintln!("no paths given and HEELER_RAW_CORPUS is not set");
            std::process::exit(2);
        };
        corpus(root, &a)
    } else {
        a.paths.clone()
    };
    let mut csv = a.csv.as_ref().map(|p| std::io::BufWriter::new(std::fs::File::create(p).expect("csv writable")));
    let header = "file,maker,camera,format,megapixels,decoder,half,runs,status,total_ms,open_ms,unpack_ms,develop_ms,out_width,out_height";
    if let Some(w) = csv.as_mut() {
        writeln!(w, "{header}").unwrap();
    }
    eprintln!("{} files, {} runs each, decoder {}, {} threads", files.len(), a.runs, a.decoder, std::thread::available_parallelism().map_or(1, |n| n.get()));
    let mut rows = Vec::new();
    for (i, path) in files.iter().enumerate() {
        let Ok(bytes) = std::fs::read(path) else { continue };
        let rel = root.as_deref().and_then(|r| path.strip_prefix(r).ok()).unwrap_or(path);
        let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
        let (maker, camera) = if parts.len() >= 3 { (parts[parts.len() - 3].clone(), parts[parts.len() - 2].clone()) } else { (String::new(), String::new()) };
        let opts = DevelopOpts { half_size: a.half, ..DevelopOpts::default() };
        let row = time_file(&a.decoder, &bytes, opts, a.runs);
        let r = Row {
            file: rel.to_string_lossy().into_owned(),
            maker,
            camera,
            format: format_of(path, &bytes),
            decoder: a.decoder.clone(),
            half: a.half,
            runs: a.runs,
            ..row
        };
        eprintln!("[{}/{}] {} {} {:.0} ms ({})", i + 1, files.len(), r.format, r.file, r.total, r.status);
        if let Some(w) = csv.as_mut() {
            writeln!(w, "{}", r.csv()).unwrap();
            w.flush().unwrap();
        }
        rows.push(r);
    }
    summarize(&rows);
}

/// The corpus's raw files in path order, filtered as asked.
fn corpus(root: &Path, a: &Args) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("._") || name.starts_with('.') || name == "filelist.sha256" {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else {
                out.push(p);
            }
        }
    }
    out.sort();
    let rel = |p: &Path| p.strip_prefix(root).unwrap_or(p).to_string_lossy().into_owned();
    out.retain(|p| {
        let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_uppercase()).unwrap_or_default();
        (a.ext.is_empty() || a.ext.contains(&ext)) && (a.only.is_empty() || a.only.iter().any(|o| rel(p).contains(o.as_str())))
    });
    if a.per_camera != usize::MAX {
        let mut seen: BTreeMap<PathBuf, usize> = BTreeMap::new();
        out.retain(|p| {
            let n = seen.entry(p.parent().map(Path::to_path_buf).unwrap_or_default()).or_default();
            *n += 1;
            *n <= a.per_camera
        });
    }
    out
}

#[derive(Default, Clone)]
struct Row {
    file: String,
    maker: String,
    camera: String,
    format: String,
    megapixels: f64,
    decoder: String,
    half: bool,
    runs: usize,
    status: String,
    total: f64,
    open: f64,
    unpack: f64,
    develop: f64,
    out_width: usize,
    out_height: usize,
}

impl Row {
    fn csv(&self) -> String {
        let q = |s: &str| if s.contains([',', '"']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() };
        format!(
            "{},{},{},{},{:.2},{},{},{},{},{:.2},{:.2},{:.2},{:.2},{},{}",
            q(&self.file), q(&self.maker), q(&self.camera), self.format, self.megapixels, self.decoder, self.half as u8, self.runs, q(&self.status),
            self.total, self.open, self.unpack, self.develop, self.out_width, self.out_height
        )
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

/// One untimed develop (the file into cache, the pools warm), then `runs`
/// timed ones; the median of each stage and of the totals.
fn time_file(decoder: &str, bytes: &[u8], opts: DevelopOpts, runs: usize) -> Row {
    let once = |bytes: &[u8]| -> Result<(StageTimes, f64, usize, usize, usize), String> {
        let t = Instant::now();
        let (img, times, sensor) = match decoder {
            "libraw" => {
                #[cfg(feature = "rust-decoder")]
                heeler_raw::rust_path::set_enabled(false);
                let (img, times) = heeler_raw::decode_sensor_timed(bytes, opts).map_err(|e| e.to_string())?;
                (img, times, 0usize)
            }
            #[cfg(feature = "rust-decoder")]
            "rust" => {
                heeler_raw::rust_path::set_enabled(true);
                if !heeler_raw::rust_path::takes(bytes, opts) {
                    return Err("declined by the Rust path".into());
                }
                let (img, times) = heeler_raw::decode_sensor_timed(bytes, opts).map_err(|e| e.to_string())?;
                (img, times, 0usize)
            }
            other => panic!("unknown decoder {other}"),
        };
        let total = t.elapsed().as_secs_f64();
        Ok((times, total, img.width, img.height, sensor))
    };
    let mut row = Row::default();
    match once(bytes) {
        Err(e) => {
            row.status = format!("error: {e}");
            return row;
        }
        Ok((_, _, w, h, sensor)) => {
            row.out_width = w;
            row.out_height = h;
            row.megapixels = if sensor > 0 { sensor as f64 / 1e6 } else { (w * h) as f64 / 1e6 };
        }
    }
    let (mut total, mut open, mut unpack, mut develop) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for _ in 0..runs {
        match once(bytes) {
            Ok((t, tot, ..)) => {
                total.push(tot * 1000.0);
                open.push(t.open * 1000.0);
                unpack.push(t.unpack * 1000.0);
                develop.push(t.develop * 1000.0);
            }
            Err(e) => {
                row.status = format!("error: {e}");
                return row;
            }
        }
    }
    row.status = "ok".into();
    row.total = median(total);
    row.open = median(open);
    row.unpack = median(unpack);
    row.develop = median(develop);
    row
}

/// The class of decoder a file needs: its extension, and for a DNG the
/// raw image's compression and photometric interpretation.
fn format_of(path: &Path, bytes: &[u8]) -> String {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_uppercase()).unwrap_or_default();
    if ext != "DNG" {
        return ext;
    }
    match dng_raw_ifd(bytes) {
        Some((compression, photometric)) => {
            let kind = match compression {
                1 => "Uncompressed",
                7 => "LJ92",
                8 | 32946 => "Deflate",
                34892 => "LossyJPEG",
                52546 => "JXL",
                _ => return format!("DNG-c{compression}"),
            };
            match (kind, photometric) {
                ("LJ92" | "Uncompressed" | "Deflate" | "JXL", 32803) => format!("DNG-{kind}-CFA"),
                ("LJ92" | "Uncompressed" | "Deflate" | "JXL", 34892) => format!("DNG-{kind}-Linear"),
                _ => format!("DNG-{kind}"),
            }
        }
        None => "DNG-unknown".into(),
    }
}

/// The compression and photometric interpretation of the main raw image
/// (NewSubFileType 0 with a CFA or linear raw photometric), searching
/// IFD0's chain and its SubIFDs.
fn dng_raw_ifd(d: &[u8]) -> Option<(u32, u32)> {
    let le = match d.get(..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |o: usize| d.get(o..o + 2).map(|b| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) });
    let u32_at = |o: usize| d.get(o..o + 4).map(|b| {
        let b = [b[0], b[1], b[2], b[3]];
        if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
    });
    let mut todo = vec![u32_at(4)? as usize];
    let mut seen = std::collections::HashSet::new();
    let mut best = None;
    while let Some(at) = todo.pop() {
        if at == 0 || !seen.insert(at) || seen.len() > 64 {
            continue;
        }
        let Some(n) = u16_at(at) else { continue };
        let (mut kind, mut comp, mut photo) = (None, None, None);
        for i in 0..n as usize {
            let e = at + 2 + i * 12;
            let (Some(tag), Some(typ), Some(count)) = (u16_at(e), u16_at(e + 2), u32_at(e + 4)) else { break };
            let one = || if typ == 3 { u16_at(e + 8).map(u32::from) } else { u32_at(e + 8) };
            match tag {
                254 => kind = one(),
                259 => comp = one(),
                262 => photo = one(),
                330 => {
                    if count == 1 {
                        todo.extend(u32_at(e + 8).map(|v| v as usize));
                    } else if let Some(off) = u32_at(e + 8) {
                        for k in 0..count.min(16) as usize {
                            todo.extend(u32_at(off as usize + k * 4).map(|v| v as usize));
                        }
                    }
                }
                _ => {}
            }
        }
        if kind == Some(0) && matches!(photo, Some(32803 | 34892)) && best.is_none() {
            best = Some((comp.unwrap_or(1), photo.unwrap_or(0)));
        }
        todo.extend(u32_at(at + 2 + n as usize * 12).map(|v| v as usize));
    }
    best
}

fn read_csv(path: &Path) -> Vec<Row> {
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut out = Vec::new();
    for line in text.lines().skip(1) {
        let mut f = Vec::new();
        let (mut cur, mut quoted, mut chars) = (String::new(), false, line.chars().peekable());
        while let Some(c) = chars.next() {
            match c {
                '"' if quoted && chars.peek() == Some(&'"') => {
                    cur.push('"');
                    chars.next();
                }
                '"' => quoted = !quoted,
                ',' if !quoted => f.push(std::mem::take(&mut cur)),
                _ => cur.push(c),
            }
        }
        f.push(cur);
        if f.len() < 15 {
            continue;
        }
        let n = |i: usize| f[i].parse::<f64>().unwrap_or(0.0);
        out.push(Row {
            file: f[0].clone(),
            maker: f[1].clone(),
            camera: f[2].clone(),
            format: f[3].clone(),
            megapixels: n(4),
            decoder: f[5].clone(),
            half: f[6] == "1",
            runs: n(7) as usize,
            status: f[8].clone(),
            total: n(9),
            open: n(10),
            unpack: n(11),
            develop: n(12),
            out_width: n(13) as usize,
            out_height: n(14) as usize,
        });
    }
    out
}

/// Per-format and per-camera totals, medians and the corpus's sum.
fn summarize(rows: &[Row]) {
    let ok: Vec<&Row> = rows.iter().filter(|r| r.status == "ok").collect();
    println!("{} files, {} decoded, {} failed", rows.len(), ok.len(), rows.len() - ok.len());
    let table = |title: &str, key: &dyn Fn(&Row) -> String| {
        let mut groups: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
        for r in &ok {
            groups.entry(key(r)).or_default().push(r);
        }
        println!("\n{title}\tfiles\tMP med\ttotal s\topen s\tunpack s\tdevelop s\tmed ms\tmed ms/MP");
        for (k, g) in groups {
            let sum = |f: &dyn Fn(&Row) -> f64| g.iter().map(|r| f(r)).sum::<f64>() / 1000.0;
            println!(
                "{k}\t{}\t{:.1}\t{:.2}\t{:.2}\t{:.2}\t{:.2}\t{:.0}\t{:.1}",
                g.len(),
                median(g.iter().map(|r| r.megapixels).collect()),
                sum(&|r| r.total),
                sum(&|r| r.open),
                sum(&|r| r.unpack),
                sum(&|r| r.develop),
                median(g.iter().map(|r| r.total).collect()),
                median(g.iter().filter(|r| r.megapixels > 0.0).map(|r| r.total / r.megapixels).collect()),
            );
        }
    };
    table("format", &|r| r.format.clone());
    table("camera", &|r| format!("{} {} ({})", r.maker, r.camera, r.format));
    let total: f64 = ok.iter().map(|r| r.total).sum();
    println!("\nall\t{}\t{:.1} s", ok.len(), total / 1000.0);
}

/// NEW against BASE on the files both decoded: the ratio of summed time
/// (new over base, lower is faster) per format and per camera, for the
/// total and each stage, with the 0.70 floor and 0.50 target marked.
fn compare(base: &[Row], new: &[Row]) {
    let by: BTreeMap<&str, &Row> = base.iter().filter(|r| r.status == "ok").map(|r| (r.file.as_str(), r)).collect();
    let pairs: Vec<(&Row, &Row)> = new.iter().filter(|r| r.status == "ok").filter_map(|n| by.get(n.file.as_str()).map(|b| (*b, n))).collect();
    println!("{} files decoded by both", pairs.len());
    let verdict = |r: f64| if r <= 0.50 { "target" } else if r <= 0.70 { "floor" } else { "below floor" };
    let table = |title: &str, key: &dyn Fn(&Row) -> String| {
        let mut groups: BTreeMap<String, Vec<(&Row, &Row)>> = BTreeMap::new();
        for &(b, n) in &pairs {
            groups.entry(key(b)).or_default().push((b, n));
        }
        println!("\n{title}\tfiles\tbase s\tnew s\tratio\tmedian ratio\tbase unpack s\tnew unpack s\tbase develop s\tnew develop s\tverdict");
        for (k, g) in groups {
            let s = |f: &dyn Fn(&(&Row, &Row)) -> f64| g.iter().map(f).sum::<f64>() / 1000.0;
            let (bt, nt) = (s(&|p| p.0.total), s(&|p| p.1.total));
            let ratio = nt / bt;
            let med = median(g.iter().map(|p| p.1.total / p.0.total).collect());
            println!(
                "{k}\t{}\t{bt:.2}\t{nt:.2}\t{ratio:.2}\t{med:.2}\t{:.2}\t{:.2}\t{:.2}\t{:.2}\t{}",
                g.len(),
                s(&|p| p.0.open + p.0.unpack),
                s(&|p| p.1.open + p.1.unpack),
                s(&|p| p.0.develop),
                s(&|p| p.1.develop),
                verdict(med)
            );
        }
    };
    table("format", &|r| r.format.clone());
    table("camera", &|r| format!("{} {} ({})", r.maker, r.camera, r.format));
}
