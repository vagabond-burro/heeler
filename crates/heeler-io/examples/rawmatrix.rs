//! The RAW support matrix: a folder of camera samples, answered per file.
//!
//!     cargo run -p heeler-io --release --features libraw --example rawmatrix -- \
//!         "$HEELER_RAW_MATRIX" [--threads 4] [--full] [--app] \
//!         [--report matrix.md] [--tsv matrix.tsv]
//!
//! Built for the raw.pixls.us corpus (one sample per camera model, CC0),
//! but any tree of raw files works. Sidecars (`._x`), dotfiles and the
//! checksum manifest are skipped, the way the catalog skips them.
//!
//! For every file this asks three things the app never says out loud:
//!
//! - would the catalog even index it (`SUPPORTED_EXTENSIONS`), and would
//!   the loader send it to LibRaw (`is_raw_extension`). The two lists
//!   differ: PEF, SRW, 3FR, IIQ, ERF, NRW, SRF and SR2 develop but are
//!   never listed, so the report keeps both columns.
//! - does LibRaw produce a sensor develop, and does that develop pass
//!   `develop_looks_sane`. Half size by default (the answer is the same
//!   and it is four times faster); `--full` asks for the real thing.
//! - what would reach the screen. `decode_any` falls back to the
//!   embedded preview whenever the develop fails or looks like noise, so
//!   a file can "open" without a single sensor pixel being read. The
//!   verdict names that case rather than counting it as a pass.
//!
//! `--app` additionally runs the real `decode_any_with` at full size and
//! records its dimensions and time, which is the ground truth the verdict
//! predicts. It roughly doubles the run. `--thumbs DIR` (with `--app`)
//! also writes a 512-pixel sRGB JPEG of every decode under DIR, mirroring
//! the corpus layout, so a person can page through what the app would
//! show and catch the casts and mosaics that no gate measures.
//!
//! Output: a progress line per file on stderr, a TSV with every column
//! (default `rawmatrix.tsv` beside the report), and a Markdown report
//! (default `rawmatrix.md` in the working directory) with the summary,
//! the per-extension table, and the failures listed by camera.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use heeler_engine::ImageBuf;
use heeler_io::{
    decode_any_with, decode_jxl_dng, develop_looks_sane, extract_raw_preview, is_jxl_dng,
    is_raw_extension, read_exif, RawSourceOpts,
};

/// One camera sample, answered.
struct Row {
    rel: String,
    make_dir: String,
    camera: String,
    ext: String,
    mb: f64,
    in_catalog: bool,
    io_raw: bool,
    /// LibRaw sensor develop: size and time, or the error it named.
    libraw: Result<(usize, usize, u128), String>,
    /// Whether that develop passed the noise gate (None when it failed).
    sane: Option<bool>,
    preview: bool,
    /// The JPEG XL DNG path, when the file is one.
    jxl: Option<Result<(usize, usize), String>>,
    /// `decode_any_with` at full size, when `--app` asked for it.
    app: Option<Result<(usize, usize, u128), String>>,
    verdict: &'static str,
}

/// What the app would put on screen for this file, as `decode_any_inner`
/// is written today. The order of these checks mirrors that function.
fn verdict(r: &Row) -> &'static str {
    if !r.in_catalog {
        return "not indexed";
    }
    if !r.io_raw {
        return "image path";
    }
    match &r.jxl {
        Some(Ok(_)) => return "jxl develop",
        Some(Err(_)) => return "jxl error",
        None => {}
    }
    match (&r.libraw, r.sane) {
        (Ok(_), Some(true)) => "develop",
        _ if r.preview => "preview fallback",
        _ => "error shown",
    }
}

/// The same conversion `sensor_to_imagebuf` does, for the sanity gate.
fn to_imagebuf(s: &heeler_raw::SensorImage) -> ImageBuf {
    let mut out = ImageBuf::new(s.width, s.height);
    let gain = s.headroom.max(1.0);
    for px in 0..s.width * s.height {
        let i = px * 3;
        let o = px * 4;
        for c in 0..3 {
            out.data[o + c] = s.rgb[i + c] as f32 / 65535.0 * gain;
        }
        out.data[o + 3] = 1.0;
    }
    out
}

/// A 512-pixel sRGB JPEG of a linear develop, for eyes rather than gates.
fn write_thumb(img: &ImageBuf, dest: &Path) -> Result<(), String> {
    let scale = (img.width.max(img.height) as f64 / 512.0).max(1.0);
    let (tw, th) = (
        ((img.width as f64 / scale) as usize).max(1),
        ((img.height as f64 / scale) as usize).max(1),
    );
    let mut out = image::RgbImage::new(tw as u32, th as u32);
    let encode = |v: f32| -> u8 {
        let v = v.clamp(0.0, 1.0);
        let s = if v <= 0.0031308 { 12.92 * v } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 };
        (s * 255.0 + 0.5) as u8
    };
    for ty in 0..th {
        for tx in 0..tw {
            // Box-average the source block, so a mosaic that survived the
            // develop shows as the checkerboard it is rather than aliasing
            // into a plausible color.
            let (x0, y0) = ((tx as f64 * scale) as usize, (ty as f64 * scale) as usize);
            let (x1, y1) = (
                (((tx + 1) as f64 * scale) as usize).clamp(x0 + 1, img.width),
                (((ty + 1) as f64 * scale) as usize).clamp(y0 + 1, img.height),
            );
            let mut acc = [0.0f32; 3];
            let mut n = 0.0f32;
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = img.pixel(x, y);
                    acc[0] += p[0];
                    acc[1] += p[1];
                    acc[2] += p[2];
                    n += 1.0;
                }
            }
            out.put_pixel(tx as u32, ty as u32, image::Rgb([encode(acc[0] / n), encode(acc[1] / n), encode(acc[2] / n)]));
        }
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(std::io::BufWriter::new(file), 85);
    enc.encode_image(&out).map_err(|e| e.to_string())
}

fn probe(root: &Path, path: &Path, full: bool, app: bool, thumbs: Option<&Path>) -> Row {
    let rel = path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned();
    let make_dir = rel.split('/').next().unwrap_or("").to_string();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let in_catalog = heeler_catalog::SUPPORTED_EXTENSIONS.contains(&ext.as_str());
    let io_raw = is_raw_extension(path);

    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            let mut r = Row {
                rel,
                make_dir,
                camera: String::new(),
                ext,
                mb: 0.0,
                in_catalog,
                io_raw,
                libraw: Err(format!("unreadable: {e}")),
                sane: None,
                preview: false,
                jxl: None,
                app: None,
                verdict: "",
            };
            r.verdict = "error shown";
            return r;
        }
    };
    let mb = bytes.len() as f64 / 1_048_576.0;
    let exif = read_exif(&bytes);
    let camera = exif.camera().unwrap_or_default();
    let preview = extract_raw_preview(&bytes).is_some();

    let jxl = if io_raw && is_jxl_dng(&bytes) {
        Some(decode_jxl_dng(&bytes).map(|i| (i.width, i.height)).map_err(|e| e.to_string()))
    } else {
        None
    };

    let opts = heeler_raw::DevelopOpts { half_size: !full, ..heeler_raw::DevelopOpts::default() };
    let started = Instant::now();
    let (libraw, sane) = match heeler_raw::decode_sensor_with(&bytes, opts) {
        Ok(s) => {
            let ms = started.elapsed().as_millis();
            let sane = develop_looks_sane(&to_imagebuf(&s));
            (Ok((s.width, s.height, ms)), Some(sane))
        }
        Err(e) => (Err(e.to_string()), None),
    };
    drop(bytes);

    let app = if app {
        let started = Instant::now();
        Some(decode_any_with(path, RawSourceOpts::default()).map_err(|e| e.to_string()).and_then(|i| {
            let took = started.elapsed().as_millis();
            if let Some(dir) = thumbs {
                let dest = dir.join(format!("{rel}.jpg"));
                write_thumb(&i, &dest).map_err(|e| format!("thumbnail: {e}"))?;
            }
            Ok((i.width, i.height, took))
        }))
    } else {
        None
    };

    let mut r = Row {
        rel,
        make_dir,
        camera,
        ext,
        mb,
        in_catalog,
        io_raw,
        libraw,
        sane,
        preview,
        jxl,
        app,
        verdict: "",
    };
    r.verdict = verdict(&r);
    r
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect(&path, out);
        } else if path.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
            if matches!(ext.as_str(), "sha256" | "txt" | "md" | "part" | "log") {
                continue;
            }
            out.push(path);
        }
    }
}

fn tsv_cell(s: &str) -> String {
    s.replace(['\t', '\n'], " ")
}

fn write_tsv(path: &Path, rows: &[Row]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    writeln!(
        f,
        "path\tmake_dir\tcamera\text\tmb\tcatalog\tio_raw\tlibraw\twidth\theight\tms\tsane\tpreview\tjxl\tapp\tapp_ms\tverdict\terror"
    )?;
    for r in rows {
        let (lr, w, h, ms, err) = match &r.libraw {
            Ok((w, h, ms)) => ("ok", w.to_string(), h.to_string(), ms.to_string(), String::new()),
            Err(e) => ("fail", String::new(), String::new(), String::new(), e.clone()),
        };
        let sane = r.sane.map(|b| if b { "yes" } else { "no" }).unwrap_or("");
        let jxl = match &r.jxl {
            None => String::new(),
            Some(Ok((w, h))) => format!("ok {w}x{h}"),
            Some(Err(e)) => format!("fail {e}"),
        };
        let (app, app_ms) = match &r.app {
            None => (String::new(), String::new()),
            Some(Ok((w, h, ms))) => (format!("ok {w}x{h}"), ms.to_string()),
            Some(Err(e)) => (format!("fail {e}"), String::new()),
        };
        writeln!(
            f,
            "{}\t{}\t{}\t{}\t{:.1}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            tsv_cell(&r.rel),
            tsv_cell(&r.make_dir),
            tsv_cell(&r.camera),
            r.ext,
            r.mb,
            if r.in_catalog { "yes" } else { "no" },
            if r.io_raw { "yes" } else { "no" },
            lr,
            w,
            h,
            ms,
            sane,
            if r.preview { "yes" } else { "no" },
            tsv_cell(&jxl),
            tsv_cell(&app),
            app_ms,
            r.verdict,
            tsv_cell(&err),
        )?;
    }
    Ok(())
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

fn write_report(
    path: &Path,
    root: &Path,
    rows: &[Row],
    full: bool,
    app: bool,
    elapsed_s: f64,
) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    writeln!(f, "# RAW support matrix\n")?;
    writeln!(f, "Corpus: `{}`  ", root.display())?;
    writeln!(
        f,
        "LibRaw {} (libjpeg {}, zlib {}), develop at {} size{}, {} files in {:.0}s.\n",
        heeler_raw::LIBRAW_VERSION,
        if heeler_raw::JPEG_LINKED { "linked" } else { "MISSING" },
        if heeler_raw::ZLIB_LINKED { "linked" } else { "MISSING" },
        if full { "full" } else { "half" },
        if app { ", plus the app's decode_any at full size" } else { "" },
        rows.len(),
        elapsed_s
    )?;

    writeln!(f, "## What the app would show\n")?;
    writeln!(f, "| Verdict | Files | Meaning |\n|---|---:|---|")?;
    let meaning = [
        ("develop", "LibRaw develops it and the result passes the noise gate"),
        ("jxl develop", "JPEG XL DNG, decoded by Heeler's own path"),
        ("preview fallback", "develop failed or looked like noise; the app silently shows the embedded JPEG"),
        ("error shown", "develop failed and there is no preview to fall back on"),
        ("jxl error", "JPEG XL DNG that Heeler's decoder refused"),
        ("image path", "extension the catalog lists but LibRaw is not asked about (TIFF)"),
        ("not indexed", "extension the catalog never lists, so the file is invisible"),
    ];
    for (v, m) in meaning {
        let n = rows.iter().filter(|r| r.verdict == v).count();
        if n > 0 {
            writeln!(f, "| {v} | {n} | {m} |")?;
        }
    }

    writeln!(f, "\n## By extension\n")?;
    writeln!(
        f,
        "| Ext | Files | Catalog | LibRaw asked | Develops | Fails | Noise | Preview only |\n|---|---:|---|---|---:|---:|---:|---:|"
    )?;
    let mut by_ext: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in rows {
        by_ext.entry(r.ext.as_str()).or_default().push(r);
    }
    for (ext, rs) in &by_ext {
        let ok = rs.iter().filter(|r| r.libraw.is_ok() && r.sane == Some(true)).count();
        let fail = rs.iter().filter(|r| r.libraw.is_err()).count();
        let noise = rs.iter().filter(|r| r.sane == Some(false)).count();
        let preview_only = rs.iter().filter(|r| r.verdict == "preview fallback").count();
        writeln!(
            f,
            "| {ext} | {} | {} | {} | {ok} | {fail} | {noise} | {preview_only} |",
            rs.len(),
            if rs[0].in_catalog { "yes" } else { "no" },
            if rs[0].io_raw { "yes" } else { "no" },
        )?;
    }

    writeln!(f, "\n## By make folder\n")?;
    writeln!(f, "| Folder | Files | Develops | Preview only | Error | Not indexed |\n|---|---:|---:|---:|---:|---:|")?;
    let mut by_make: BTreeMap<&str, Vec<&Row>> = BTreeMap::new();
    for r in rows {
        by_make.entry(r.make_dir.as_str()).or_default().push(r);
    }
    for (make, rs) in &by_make {
        let count = |v: &str| rs.iter().filter(|r| r.verdict == v).count();
        writeln!(
            f,
            "| {} | {} | {} | {} | {} | {} |",
            md_cell(make),
            rs.len(),
            count("develop") + count("jxl develop"),
            count("preview fallback"),
            count("error shown") + count("jxl error"),
            count("not indexed"),
        )?;
    }

    writeln!(f, "\n## Indexed files that do not develop\n")?;
    writeln!(f, "These open in the app today, but not as a develop.\n")?;
    writeln!(f, "| Verdict | Camera | File | LibRaw said |\n|---|---|---|---|")?;
    let mut any = false;
    for r in rows.iter().filter(|r| matches!(r.verdict, "preview fallback" | "error shown" | "jxl error")) {
        any = true;
        let said = match (&r.libraw, r.sane, &r.jxl) {
            (_, _, Some(Err(e))) => format!("jxl: {e}"),
            (Err(e), _, _) => e.clone(),
            (Ok(_), Some(false), _) => "decoded, but the result looks like noise".into(),
            _ => String::new(),
        };
        writeln!(
            f,
            "| {} | {} | {} | {} |",
            r.verdict,
            md_cell(&r.camera),
            md_cell(&r.rel),
            md_cell(&said)
        )?;
    }
    if !any {
        writeln!(f, "| (none) | | | |")?;
    }

    writeln!(f, "\n## Not indexed, but LibRaw develops them\n")?;
    writeln!(f, "What listing the extension in the catalog would gain.\n")?;
    writeln!(f, "| Ext | Develops | Of | Cameras |\n|---|---:|---:|---|")?;
    for (ext, rs) in &by_ext {
        if rs[0].in_catalog {
            continue;
        }
        let ok: Vec<&&Row> = rs.iter().filter(|r| r.libraw.is_ok() && r.sane == Some(true)).collect();
        if ok.is_empty() {
            continue;
        }
        let mut cams: Vec<String> = ok.iter().map(|r| r.camera.clone()).filter(|c| !c.is_empty()).collect();
        cams.sort();
        cams.dedup();
        let shown = if cams.len() > 8 {
            format!("{} and {} more", cams[..8].join(", "), cams.len() - 8)
        } else {
            cams.join(", ")
        };
        writeln!(f, "| {ext} | {} | {} | {} |", ok.len(), rs.len(), md_cell(&shown))?;
    }

    if app {
        writeln!(f, "\n## Where the prediction and decode_any disagree\n")?;
        writeln!(f, "| Verdict | decode_any | Camera | File |\n|---|---|---|---|")?;
        let mut any = false;
        for r in rows {
            let Some(app) = &r.app else { continue };
            let agrees = match (r.verdict, app) {
                ("develop" | "jxl develop" | "image path", Ok(_)) => true,
                ("preview fallback", Ok(_)) => true,
                ("error shown" | "jxl error", Err(_)) => true,
                ("not indexed", _) => true,
                _ => false,
            };
            if agrees {
                continue;
            }
            any = true;
            let said = match app {
                Ok((w, h, ms)) => format!("ok {w}x{h} in {ms} ms"),
                Err(e) => format!("fail: {e}"),
            };
            writeln!(f, "| {} | {} | {} | {} |", r.verdict, md_cell(&said), md_cell(&r.camera), md_cell(&r.rel))?;
        }
        if !any {
            writeln!(f, "| (none) | | | |")?;
        }
    }

    let mut slow: Vec<&Row> = rows.iter().filter(|r| r.libraw.is_ok()).collect();
    slow.sort_by_key(|r| std::cmp::Reverse(r.libraw.as_ref().map(|t| t.2).unwrap_or(0)));
    writeln!(f, "\n## Slowest develops\n")?;
    writeln!(f, "| ms | MB | Camera | File |\n|---:|---:|---|---|")?;
    for r in slow.iter().take(10) {
        let (w, h, ms) = r.libraw.as_ref().unwrap();
        writeln!(f, "| {ms} | {:.1} | {} | {} ({w}x{h}) |", r.mb, md_cell(&r.camera), md_cell(&r.rel))?;
    }
    Ok(())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut root: Option<PathBuf> = None;
    let mut threads = 4usize;
    let mut full = false;
    let mut app = false;
    let mut report = PathBuf::from("rawmatrix.md");
    let mut tsv: Option<PathBuf> = None;
    let mut thumbs: Option<PathBuf> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--threads" => threads = args.next().and_then(|v| v.parse().ok()).unwrap_or(4),
            "--full" => full = true,
            "--app" => app = true,
            "--report" => report = args.next().map(PathBuf::from).unwrap_or(report),
            "--tsv" => tsv = args.next().map(PathBuf::from),
            "--thumbs" => thumbs = args.next().map(PathBuf::from),
            _ if root.is_none() => root = Some(PathBuf::from(a)),
            _ => {
                eprintln!("unexpected argument {a}");
                std::process::exit(2);
            }
        }
    }
    let Some(root) = root.or_else(|| std::env::var_os("HEELER_RAW_MATRIX").map(PathBuf::from)) else {
        eprintln!("usage: rawmatrix <dir> [--threads N] [--full] [--app] [--report out.md] [--tsv out.tsv] [--thumbs dir]");
        std::process::exit(2);
    };
    if thumbs.is_some() && !app {
        eprintln!("--thumbs needs --app: the thumbnails are of the app's decode");
        std::process::exit(2);
    }
    let tsv = tsv.unwrap_or_else(|| report.with_extension("tsv"));

    let mut files = Vec::new();
    collect(&root, &mut files);
    files.sort();
    let total = files.len();
    eprintln!(
        "{total} files under {}; LibRaw {}, {} threads, {} size{}",
        root.display(),
        heeler_raw::LIBRAW_VERSION,
        threads,
        if full { "full" } else { "half" },
        if app { ", with decode_any" } else { "" }
    );

    let started = Instant::now();
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let rows: Mutex<Vec<Row>> = Mutex::new(Vec::with_capacity(total));
    std::thread::scope(|s| {
        for _ in 0..threads.max(1) {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= total {
                    break;
                }
                let row = probe(&root, &files[i], full, app, thumbs.as_deref());
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                let took = row.libraw.as_ref().map(|t| t.2).unwrap_or(0);
                eprintln!("[{n}/{total}] {:<16} {took:>6} ms  {}", row.verdict, row.rel);
                rows.lock().unwrap().push(row);
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort_by(|a, b| a.rel.cmp(&b.rel));
    let elapsed = started.elapsed().as_secs_f64();

    if let Err(e) = write_tsv(&tsv, &rows) {
        eprintln!("could not write {}: {e}", tsv.display());
    }
    if let Err(e) = write_report(&report, &root, &rows, full, app, elapsed) {
        eprintln!("could not write {}: {e}", report.display());
    }
    let count = |v: &str| rows.iter().filter(|r| r.verdict == v).count();
    eprintln!(
        "\ndone in {elapsed:.0}s: {} develop, {} preview fallback, {} error, {} not indexed, {} image path. Report: {}",
        count("develop") + count("jxl develop"),
        count("preview fallback"),
        count("error shown") + count("jxl error"),
        count("not indexed"),
        count("image path"),
        report.display()
    );
}
