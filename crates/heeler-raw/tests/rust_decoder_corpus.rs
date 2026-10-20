//! Every DNG of the sample corpus the Rust develop takes (its rules and
//! its verified cameras, heeler-rawdec's plan) develops as LibRaw does,
//! to the bit: the unpacked mosaic, then full size and half, Clip and
//! Blend. And every verified camera still has a file the develop takes,
//! so the list in heeler-rawdec's verified.rs names nothing untested.
//!
//! The corpus is a public sample archive (maker/camera/file), found at
//! HEELER_RAW_CORPUS; the test passes, saying so, when that is unset.
//! A few minutes in release on a recent Mac.
use heeler_raw::DevelopOpts;
use heeler_rawdec::Opts;

fn opts(o: DevelopOpts) -> Opts {
    Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic }
}

fn dngs(root: &std::path::Path) -> Vec<std::path::PathBuf> {
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
            } else if name.to_ascii_uppercase().ends_with(".DNG") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn every_corpus_dng_the_rust_develop_takes_is_libraws_develop() {
    let Some(root) = std::env::var_os("HEELER_RAW_CORPUS") else {
        eprintln!("HEELER_RAW_CORPUS not set; skipping the corpus comparison");
        return;
    };
    let mut taken = 0;
    let mut cameras = std::collections::BTreeSet::new();
    let mut failures = Vec::new();
    for path in dngs(std::path::Path::new(&root)) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(plan) = heeler_rawdec::plan(&bytes, &opts(DevelopOpts::default())) else { continue };
        taken += 1;
        cameras.insert((plan.dng.make.clone(), plan.dng.model.clone()));
        let name = path.strip_prefix(&root).unwrap_or(&path).display().to_string();
        let mosaic = heeler_rawdec::develop::unpack(&bytes, &plan, None);
        match (mosaic, heeler_raw::libraw_mosaic(&bytes)) {
            (Ok(mine), Ok((_, _, theirs))) if mine == theirs => {}
            _ => failures.push(format!("{name}: the unpacked mosaic")),
        }
        for half_size in [false, true] {
            for highlight in [0, 2] {
                let o = DevelopOpts { half_size, highlight, ..DevelopOpts::default() };
                let theirs = heeler_raw::decode_sensor_with(&bytes, o).unwrap();
                match heeler_rawdec::develop(&bytes, &opts(o), None) {
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
    eprintln!("{taken} corpus DNGs from {} cameras compared", cameras.len());
    assert!(failures.is_empty(), "{} differ from LibRaw:\n{}", failures.len(), failures.join("\n"));
    let listed = heeler_rawdec::verified_cameras();
    let untested: Vec<_> = listed.iter().filter(|(m, n)| !cameras.contains(&(m.to_string(), n.to_string()))).collect();
    assert!(untested.is_empty(), "verified cameras with no corpus file taken: {untested:?}");
}
