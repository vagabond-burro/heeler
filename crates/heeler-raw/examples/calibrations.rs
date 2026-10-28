//! Builds heeler-rawdec's table of camera color calibrations
//! (src/calibrations.rs) for the raw formats whose files carry none: for
//! each camera folder of the corpora at HEELER_RAW_CORPUS (a list of
//! folders, as PATH is), a converter
//! writes a small DNG from one of the camera's files, and the camera
//! profile tags in it (the two calibration illuminants, ColorMatrix1/2,
//! ForwardMatrix1/2, and whether the profile also carries hue and
//! saturation tables) become the camera's row, keyed by the Make and Model
//! the DNG gives. Each row is checked against LibRaw's develop matrix for
//! the original file: the camera to sRGB matrix both give for daylight.
//!
//!   cargo run --release -p heeler-raw --example calibrations -- CONVERTER WORK_DIR OUT.rs [REPORT.csv]
//!
//! CONVERTER is the converter's command-line program; it is run as
//! `CONVERTER -c -lossy -side 256 -p0 -d WORK_DIR FILE` (a reduced, lossy
//! DNG: the profile tags are the camera's whatever the size). DNG files in
//! the corpus are skipped, since they carry their own calibrations.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::Command;

use heeler_rawdec::color::{as3, srgb_from_camera};
use heeler_rawdec::dng::illuminant_kelvin;
use heeler_rawdec::tiff::Tiff;

/// One camera's calibration as a DNG profile states it.
struct Row {
    make: String,
    model: String,
    illuminants: [u32; 2],
    color: [Vec<f64>; 2],
    forward: [Vec<f64>; 2],
    tables: bool,
    sample: String,
    libraw: String,
}

/// The profile tags of a DNG's first directory.
fn profile(bytes: &[u8]) -> Option<Row> {
    let t = Tiff::new(bytes)?;
    let ifd = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd.get(tag).and_then(|e| t.ascii(&e)).unwrap_or_default();
    let reals = |tag| ifd.get(tag).and_then(|e| t.reals(&e)).filter(|v| v.len() == 9).unwrap_or_default();
    let uint = |tag| ifd.get(tag).and_then(|e| t.uint(&e)).unwrap_or(0);
    let color = [reals(50721), reals(50722)];
    if color[0].is_empty() {
        return None;
    }
    Some(Row {
        make: ascii(271),
        model: ascii(272),
        illuminants: [uint(50778), uint(50779)],
        color,
        forward: [reals(50964), reals(50965)],
        // ProfileHueSatMapData1/2 and ProfileLookTableData.
        tables: [50938u16, 50939, 50982].iter().any(|&tag| ifd.get(tag).is_some()),
        sample: String::new(),
        libraw: String::new(),
    })
}

/// How LibRaw's develop matrix for `raw` compares with the row's daylight
/// calibration, as the camera to sRGB matrices both give.
fn against_libraw(raw: &[u8], row: &Row) -> String {
    let Ok(f) = heeler_raw::linear_dng::libraw_facts(raw, heeler_raw::DevelopOpts::default()) else { return "LibRaw cannot open".into() };
    let k = if illuminant_kelvin(row.illuminants[1]) >= illuminant_kelvin(row.illuminants[0]) && !row.color[1].is_empty() { 1 } else { 0 };
    let Some((ours, _)) = as3(&row.color[k]).and_then(|m| srgb_from_camera(&m)) else { return "singular".into() };
    let worst = (0..9).map(|i| (ours[i / 3][i % 3] - f.rgb_cam[i / 3][i % 3] as f64).abs()).fold(0.0, f64::max);
    if f.rgb_cam.iter().all(|r| r[..3].iter().all(|&v| v == 0.0)) {
        "LibRaw has no matrix".into()
    } else if worst < 2e-3 {
        "same".into()
    } else if worst < 0.05 {
        format!("close ({worst:.3})")
    } else {
        format!("differs ({worst:.3})")
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("calibrations CONVERTER WORK_DIR OUT.rs [REPORT.csv]");
        std::process::exit(2);
    }
    let (converter, work, out) = (&args[0], PathBuf::from(&args[1]), &args[2]);
    let roots: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("HEELER_RAW_CORPUS").expect("HEELER_RAW_CORPUS")).collect();
    std::fs::create_dir_all(&work).unwrap();
    let mut folders: Vec<(PathBuf, PathBuf)> = Vec::new();
    for root in &roots {
        for maker in std::fs::read_dir(root).unwrap().flatten() {
            if maker.path().is_dir() {
                for cam in std::fs::read_dir(maker.path()).unwrap().flatten() {
                    if cam.path().is_dir() {
                        folders.push((root.clone(), cam.path()));
                    }
                }
            }
        }
    }
    folders.sort();
    let mut rows: BTreeMap<(String, String), Row> = BTreeMap::new();
    let mut failed = Vec::new();
    for (n, (root, folder)) in folders.iter().enumerate() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(folder).unwrap().flatten().map(|e| e.path()).filter(|p| {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let ext = p.extension().map(|e| e.to_string_lossy().to_ascii_uppercase()).unwrap_or_default();
            !name.starts_with('.') && p.is_file() && ext != "DNG"
        }).collect();
        files.sort();
        let rel = folder.strip_prefix(root).unwrap().display().to_string();
        let mut done = false;
        for file in files.iter().take(3) {
            let dir = work.join(format!("{n}"));
            std::fs::create_dir_all(&dir).unwrap();
            let ok = Command::new(converter).args(["-c", "-lossy", "-side", "256", "-p0", "-d"]).arg(&dir).arg(file).output().map(|o| o.status.success()).unwrap_or(false);
            let stem = file.file_stem().unwrap().to_string_lossy().to_string();
            let dng = dir.join(format!("{stem}.dng"));
            if !ok || !dng.is_file() {
                continue;
            }
            let Some(mut row) = profile(&std::fs::read(&dng).unwrap()) else { continue };
            row.sample = file.strip_prefix(root).unwrap().display().to_string();
            row.libraw = against_libraw(&std::fs::read(file).unwrap(), &row);
            eprintln!("[{}/{}] {rel}: {} {} ({})", n + 1, folders.len(), row.make, row.model, row.libraw);
            rows.entry((row.make.clone(), row.model.clone())).or_insert(row);
            done = true;
            break;
        }
        if !done && !files.is_empty() {
            eprintln!("[{}/{}] {rel}: no calibration", n + 1, folders.len());
            failed.push(rel);
        }
    }
    let m = |v: &[f64]| if v.is_empty() { "None".to_string() } else { format!("Some([{}])", v.iter().map(|x| format!("{x:.4}")).collect::<Vec<_>>().join(", ")) };
    let mut src = String::from(
        "// Generated by crates/heeler-raw/examples/calibrations.rs from DNGs a\n\
         // converter wrote from the corpus's files; do not edit by hand.\n\
         // Make, Model, calibration illuminants (EXIF LightSource codes),\n\
         // ColorMatrix1/2, ForwardMatrix1/2, and whether the profile also has\n\
         // hue and saturation tables.\n\
         pub(crate) const CALIBRATIONS: &[Calibration] = &[\n",
    );
    for r in rows.values() {
        src += &format!(
            "    Calibration {{ make: {:?}, model: {:?}, illuminants: [{}, {}], color_matrix: [{}, {}], forward_matrix: [{}, {}], tables: {} }},\n",
            r.make, r.model, r.illuminants[0], r.illuminants[1], m(&r.color[0]), m(&r.color[1]), m(&r.forward[0]), m(&r.forward[1]), r.tables
        );
    }
    src += "];\n";
    std::fs::write(out, src).unwrap();
    if let Some(report) = args.get(3) {
        let mut csv = String::from("make,model,illuminant1,illuminant2,forward_matrix,hue_sat_tables,libraw,sample\n");
        for r in rows.values() {
            let q = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
            csv += &format!("{},{},{},{},{},{},{},{}\n", q(&r.make), q(&r.model), r.illuminants[0], r.illuminants[1], !r.forward[0].is_empty(), r.tables, q(&r.libraw), q(&r.sample));
        }
        std::fs::write(report, csv).unwrap();
    }
    eprintln!("{} cameras, {} folders without a calibration: {failed:?}", rows.len(), failed.len());
}
