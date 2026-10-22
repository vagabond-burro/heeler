//! Every DNG, CR2, CR3, ARW, NEF, RW2 and ORF of the sample corpus the Rust
//! develop takes (its rules and its verified cameras, heeler-rawdec's plan)
//! develops as LibRaw does, to the bit, given LibRaw's matrix and levels: the unpacked
//! mosaic, then full size and half, Clip and Blend, lens shading opcodes
//! applied as heeler-raw applies them around LibRaw. And every verified
//! camera still has a file the develop takes, so the list in
//! heeler-rawdec's verified.rs names nothing untested. A file LibRaw
//! cannot open (a few RW2s) has nothing to be held to and is counted apart.
//!
//! The corpus is a public archive of sample raw files (maker/camera/file),
//! found at HEELER_RAW_CORPUS, which can name further folders (a second
//! archive's mirror), separated as PATH's are; the test passes, saying so, when that is
//! unset.
//! A few minutes in release on a recent Mac.
use heeler_raw::DevelopOpts;
use heeler_rawdec::Opts;

fn opts(o: DevelopOpts) -> Opts {
    Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic, libraw_color: true }
}

/// Held for a whole test: each turns heeler-raw's process-wide routing.
static ROUTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The files with one of `exts` (upper case) in the corpus folders
/// `roots` names, each with the name it is reported by.
fn files(roots: &std::ffi::OsStr, exts: &[&str]) -> Vec<(std::path::PathBuf, String)> {
    let mut out = Vec::new();
    for root in std::env::split_paths(roots) {
        for p in files_in(&root, exts) {
            let name = p.strip_prefix(&root).unwrap_or(&p).display().to_string();
            out.push((p, name));
        }
    }
    out
}

fn files_in(root: &std::path::Path, exts: &[&str]) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if exts.iter().any(|e| name.to_ascii_uppercase().ends_with(&format!(".{e}"))) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn every_corpus_raw_the_rust_develop_takes_is_libraws_develop() {
    let Some(root) = std::env::var_os("HEELER_RAW_CORPUS") else {
        eprintln!("HEELER_RAW_CORPUS not set; skipping the corpus comparison");
        return;
    };
    let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(feature = "rust-decoder")]
    heeler_raw::rust_path::set_enabled(false);
    let mut taken = 0;
    let mut cameras = std::collections::BTreeSet::new();
    let mut failures = Vec::new();
    let mut unreadable = Vec::new();
    for (path, name) in files(&root, &["DNG", "CR2", "CR3", "ARW", "NEF", "RW2", "ORF"]) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(plan) = heeler_rawdec::plan(&bytes, &opts(DevelopOpts::default())) else { continue };
        let Ok((_, _, theirs)) = heeler_raw::libraw_mosaic(&bytes) else {
            unreadable.push(name);
            continue;
        };
        taken += 1;
        cameras.insert((plan.dng.format.name().to_string(), plan.dng.make.clone(), plan.dng.model.clone()));
        match heeler_rawdec::develop::unpack(&bytes, &plan, None) {
            Ok(mine) if mine == theirs => {}
            _ => failures.push(format!("{name}: the unpacked mosaic")),
        }
        // The matrix and levels are LibRaw's here: what this holds to
        // LibRaw is the decode and develop, not where those numbers come
        // from (LibRaw's own tables can round a camera's matrix apart from
        // the file's, a CR2's black is measured its own way, and the
        // shipped develop's color is the DNG model, tested on its own).
        let with = heeler_raw::with_libraw_numbers(&bytes, &plan).unwrap_or_else(|_| plan.clone());
        for half_size in [false, true] {
            for highlight in [0, 2] {
                let o = DevelopOpts { half_size, highlight, ..DevelopOpts::default() };
                let theirs = heeler_raw::decode_sensor_with(&bytes, o).unwrap();
                match heeler_rawdec::develop::develop_with(&bytes, &with, &opts(o), None) {
                    Ok((mine, _)) if (mine.width, mine.height) == (theirs.width, theirs.height) && mine.rgb == theirs.rgb && mine.headroom == theirs.headroom => {}
                    Ok((mine, _)) => {
                        let n = mine.rgb.iter().zip(&theirs.rgb).filter(|(a, b)| a != b).count();
                        failures.push(format!("{name}: half {half_size} highlight {highlight}: {n} samples differ"));
                    }
                    Err(e) => failures.push(format!("{name}: half {half_size} highlight {highlight}: {e}")),
                }
            }
        }
    }
    #[cfg(feature = "rust-decoder")]
    heeler_raw::rust_path::set_enabled(true);
    eprintln!("{taken} corpus files from {} cameras compared; {} LibRaw cannot open: {unreadable:?}", cameras.len(), unreadable.len());
    assert!(failures.is_empty(), "{} differ from LibRaw:\n{}", failures.len(), failures.join("\n"));
    let listed = heeler_rawdec::verified_cameras();
    let untested: Vec<_> = listed.iter().filter(|(f, m, n)| !cameras.contains(&(f.to_string(), m.to_string(), n.to_string()))).collect();
    assert!(untested.is_empty(), "verified cameras with no corpus file taken: {untested:?}");
}

/// With the rust-decoder feature, the linear DNGs of the corpus that
/// heeler-raw's linear module takes, their facts read in Rust and their
/// pieces decoded by heeler-rawdec, develop as LibRaw does, to the bit,
/// with LibRaw's color: every row, under Clip and Blend.
#[test]
#[cfg(all(feature = "rust-decoder", target_arch = "aarch64", target_vendor = "apple"))]
fn every_corpus_linear_dng_the_module_takes_is_libraws_develop() {
    use heeler_raw::linear_dng::LinearDng;
    let Some(root) = std::env::var_os("HEELER_RAW_CORPUS") else {
        eprintln!("HEELER_RAW_CORPUS not set; skipping the linear corpus comparison");
        return;
    };
    let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    heeler_raw::rust_path::set_libraw_color(true);
    let mut taken = 0;
    let mut failures = Vec::new();
    for (path, name) in files(&root, &["DNG"]) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        for highlight in [0, 2] {
            let o = DevelopOpts { highlight, ..DevelopOpts::default() };
            heeler_raw::rust_path::set_enabled(true);
            let Ok(Some(dng)) = LinearDng::open(bytes.clone(), o) else { continue };
            if highlight == 0 {
                taken += 1;
            }
            let n = dng.numbers(dng.data_maximum().unwrap(), highlight);
            let (w, h) = dng.size();
            let rows = dng.rows(&n, 0, h).unwrap();
            heeler_raw::rust_path::set_enabled(false);
            let theirs = heeler_raw::decode_sensor_with(&bytes, o).unwrap();
            if (w, h) != (theirs.width, theirs.height) || rows != theirs.rgb {
                failures.push(format!("{name}: highlight {highlight}"));
            }
        }
    }
    heeler_raw::rust_path::set_enabled(true);
    heeler_raw::rust_path::set_libraw_color(false);
    eprintln!("{taken} corpus linear DNGs compared");
    assert!(failures.is_empty(), "{} differ from LibRaw:\n{}", failures.len(), failures.join("\n"));
    assert!(taken >= 10, "only {taken} linear DNGs taken");
}
