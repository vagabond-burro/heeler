//! Every DNG, CR2, CR3, ARW, NEF (and NRW), RW2 (and RAW, RWL), ORF (and
//! ORI), PEF, SRW, MRW, CRW, RAF and the rest of the sample corpus the Rust develop takes (its
//! rules and its verified cameras, heeler-rawdec's plan) develops as LibRaw
//! does, to the bit, given LibRaw's matrix and levels: the unpacked mosaic,
//! then full size and half, Clip and Blend, lens shading opcodes
//! applied as heeler-raw applies them around LibRaw. An X-Trans file's
//! full size, through Heeler's own demosaic, is held to LibRaw's by a
//! floor on the PSNR (XTRANS_FLOOR_DB) instead, as is the develop of an
//! IIQ back whose sensor calibration is found only closely (NEAR_FLOOR_DB).
//! 3FR, FFF, ERF, MEF, MOS, IIQ and GPR files are taken too. And every verified
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

/// The least PSNR, in dB, an X-Trans file's full-size develop may have
/// against LibRaw's (the owner's decision of 2026-10-25): just under the
/// corpora's worst, 38.5 dB, fine twigs and branches against clipped sky.
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
const XTRANS_FLOOR_DB: f64 = 38.0;

/// The least PSNR, in dB, a develop of a camera held to LibRaw within a
/// tolerance (heeler-rawdec's verified_near: IIQ backs whose calibration
/// is found only closely, Nikon's small raws, Blackmagic's lossy
/// CinemaDNGs, whose unpacked mosaic is held to it too) may have against
/// LibRaw's: the corpora's worst is 65 dB.
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
const NEAR_FLOOR_DB: f64 = 60.0;

/// The PSNR of `a` against `b`, 16-bit samples.
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn psnr(a: &[u16], b: &[u16]) -> f64 {
    let se: f64 = a.iter().zip(b).map(|(&x, &y)| (x as f64 - y as f64).powi(2)).sum();
    if se == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (65535.0f64 * 65535.0 / (se / a.len() as f64)).log10()
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
    for (path, name) in files(&root, &["DNG", "CR2", "CR3", "ARW", "NEF", "NRW", "RW2", "RAW", "RWL", "ORF", "ORI", "PEF", "SRW", "MRW", "CRW", "RAF", "3FR", "FFF", "ERF", "MEF", "MOS", "IIQ", "GPR", "SR2", "ARQ", "KDC", "DCR", "TIF", "TIFF", "STI"]) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(plan) = heeler_rawdec::plan(&bytes, &opts(DevelopOpts::default())) else { continue };
        // LibRaw reads a GPR as heeler-raw rewrites it, its tile decoded;
        // the Rust develop reads the file itself.
        let converted = heeler_raw::gpr_as_dng(&bytes).ok().flatten();
        let lb: &[u8] = converted.as_deref().unwrap_or(&bytes);
        // An image of three samples a pixel (a Canon sRAW) has no mosaic:
        // its outputs below are what is held to LibRaw's.
        let (format, make, model) = heeler_rawdec::camera_key(&plan);
        // A file whose develop departs from LibRaw's where LibRaw's is a
        // fault (verified_libraw_fault says how it was checked instead):
        // its shipped develop must still finish, and it counts as taken.
        let fault = heeler_rawdec::verified_libraw_fault(&plan).is_some();
        // A SuperCCD frame's samples are placed on a diagonal image LibRaw
        // has no unpacked mosaic of: its develop below holds the placement.
        let superccd = matches!(plan.dng.coding, heeler_rawdec::dng::Coding::SuperCcd(_));
        if !plan.three() && !fault && !superccd {
            let Ok((_, _, theirs)) = heeler_raw::libraw_mosaic(lb) else {
                unreadable.push(name);
                continue;
            };
            match heeler_rawdec::develop::unpack(&bytes, &plan, None) {
                Ok(mine) if mine == theirs => {}
                // A camera held to LibRaw within a tolerance (a lossy
                // CinemaDNG, its inverse DCT found only closely): the same
                // floor on the mosaic's PSNR.
                Ok(mine) if heeler_rawdec::verified_near(format, &make, &model) && mine.len() == theirs.len() && psnr(&mine, &theirs) >= NEAR_FLOOR_DB => {}
                _ => failures.push(format!("{name}: the unpacked mosaic")),
            }
        }
        taken += 1;
        cameras.insert((format.to_string(), make.clone(), model.clone()));
        // The shipped develop, with its own levels and color, finishes: one
        // that fails goes to LibRaw without a word, which this would hide.
        let shipped = Opts { libraw_color: false, ..opts(DevelopOpts::default()) };
        if let Err(e) = heeler_rawdec::develop(&bytes, &shipped, None) {
            failures.push(format!("{name}: the shipped develop: {e}"));
        }
        if fault {
            continue;
        }
        // The matrix and levels are LibRaw's here: what this holds to
        // LibRaw is the decode and develop, not where those numbers come
        // from (LibRaw's own tables can round a camera's matrix apart from
        // the file's, a CR2's black is measured its own way, a file stating
        // no balance is balanced from the picture, and the shipped
        // develop's color is the DNG model, tested on its own).
        let with = heeler_raw::with_libraw_numbers(lb, &plan).unwrap_or_else(|_| plan.clone());
        for half_size in [false, true] {
            for highlight in [0, 2] {
                // A SuperCCD frame: full size only, held to LibRaw's AHD
                // (which Heeler ships for it), not its default PPG.
                if superccd && half_size {
                    continue;
                }
                let o = DevelopOpts { half_size, highlight, ..DevelopOpts::default() };
                let theirs = heeler_raw::decode_sensor_with(lb, if superccd { DevelopOpts { demosaic: 3, ..o } } else { o }).unwrap();
                let with = heeler_raw::with_libraw_balance(lb, &with, o);
                // The size the app is told before the develop is the one
                // the develop hands back, stretched pixels included.
                if with.output_size(half_size) != (theirs.width, theirs.height) {
                    failures.push(format!("{name}: half {half_size}: the plan's size {:?}, LibRaw's {:?}", with.output_size(half_size), (theirs.width, theirs.height)));
                }
                match heeler_rawdec::develop::develop_with(&bytes, &with, &opts(o), None) {
                    // A monochrome frame's headroom is 1: LibRaw's, from
                    // multipliers it never applies, means nothing.
                    Ok((mine, _)) if (mine.width, mine.height) == (theirs.width, theirs.height) && mine.rgb == theirs.rgb && (mine.headroom == theirs.headroom || plan.mono()) => {}
                    // A camera held to LibRaw within a tolerance (an IIQ back
                    // whose calibration is found only closely): a floor on
                    // the PSNR, at both sizes.
                    Ok((mine, _)) if heeler_rawdec::verified_near(format, &make, &model) && (mine.width, mine.height) == (theirs.width, theirs.height) => {
                        let psnr = psnr(&mine.rgb, &theirs.rgb);
                        if psnr < NEAR_FLOOR_DB {
                            failures.push(format!("{name}: half {half_size} highlight {highlight}: PSNR {psnr:.1} dB, under {NEAR_FLOOR_DB}"));
                        }
                    }
                    // An X-Trans develop's full size goes through Heeler's own
                    // demosaic, held to LibRaw's by a floor on the PSNR.
                    Ok((mine, _)) if plan.xtrans.is_some() && !half_size && (mine.width, mine.height) == (theirs.width, theirs.height) && mine.headroom == theirs.headroom => {
                        let psnr = psnr(&mine.rgb, &theirs.rgb);
                        if psnr < XTRANS_FLOOR_DB {
                            failures.push(format!("{name}: X-Trans full size highlight {highlight}: PSNR {psnr:.1} dB, under {XTRANS_FLOOR_DB}"));
                        }
                    }
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

/// Every headerless file of the corpus of a size heeler-rawdec knows
/// decodes to LibRaw's whole frame, to the sample, whether or not its
/// camera has the calibrations a develop needs.
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn every_corpus_headerless_frame_is_libraws() {
    let Some(root) = std::env::var_os("HEELER_RAW_CORPUS") else {
        eprintln!("HEELER_RAW_CORPUS not set; skipping the headerless comparison");
        return;
    };
    let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    let mut taken = 0;
    let mut failures = Vec::new();
    for (path, name) in files(&root, &["CRW", "CR2", "RAW", "MRW"]) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok((w, h, mine)) = heeler_rawdec::headerless::frame(&bytes) else { continue };
        taken += 1;
        match heeler_raw::libraw_frame(&bytes) {
            Ok((lw, lh, theirs)) if (lw, lh) == (w, h) && theirs == mine => {}
            Ok((lw, lh, _)) => failures.push(format!("{name}: {w}x{h} vs LibRaw's {lw}x{lh}, or samples differ")),
            Err(e) => failures.push(format!("{name}: LibRaw: {e:?}")),
        }
    }
    eprintln!("{taken} headerless corpus files compared");
    assert!(failures.is_empty(), "{} differ from LibRaw:\n{}", failures.len(), failures.join("\n"));
}

/// Every RAF of the corpus whose samples heeler-rawdec reads (Bayer and
/// X-Trans, Fujifilm's lossless compression among them) decodes to
/// LibRaw's whole frame, to the sample, whether or not the develop takes
/// the file yet.
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn every_corpus_raf_frame_is_libraws() {
    let Some(root) = std::env::var_os("HEELER_RAW_CORPUS") else {
        eprintln!("HEELER_RAW_CORPUS not set; skipping the RAF frame comparison");
        return;
    };
    let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    let mut taken = 0;
    let mut failures = Vec::new();
    for (path, name) in files(&root, &["RAF"]) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok((w, h, mine)) = heeler_rawdec::raf::frame(&bytes) else { continue };
        taken += 1;
        match heeler_raw::libraw_frame(&bytes) {
            Ok((lw, lh, theirs)) if (lw, lh) == (w, h) && theirs == mine => {}
            Ok((lw, lh, _)) => failures.push(format!("{name}: {w}x{h} vs LibRaw's {lw}x{lh}, or samples differ")),
            Err(e) => failures.push(format!("{name}: LibRaw: {e:?}")),
        }
    }
    eprintln!("{taken} RAF frames compared");
    assert!(failures.is_empty(), "{} differ from LibRaw:\n{}", failures.len(), failures.join("\n"));
}
