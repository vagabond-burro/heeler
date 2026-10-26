//! Builds heeler-rawdec's table of LibRaw's matrices (src/libraw_matrices.rs)
//! for the cameras the calibration table (src/calibrations.rs) lacks
//! because no DNG converter reads their files: for every raw file of the
//! corpora at HEELER_RAW_CORPUS (a list of folders, as PATH is, and of
//! any further folders given after OUT.rs) whose camera has no
//! calibration, the develop matrix LibRaw opens
//! it with, turned back into an XYZ-to-camera matrix for D65 (the matrix
//! inverted, each row scaled back by LibRaw's daylight multiplier, then
//! sRGB's primaries in XYZ), keyed by Make and Model as
//! heeler-rawdec names the camera. A camera whose files disagree, or which
//! LibRaw develops without a matrix, is left out and reported. Rerun it
//! after the calibration table is regenerated: a camera that table has
//! gained drops out of this one. A camera of four colors (CMYG, RGBE)
//! takes its matrix from LibRaw's 3 by 4 the same way, through its
//! pseudoinverse, as four rows of three (LIBRAW_MATRICES_4).
//!
//!   cargo run --release -p heeler-raw --example libraw_matrices -- OUT.rs [folders]
use std::collections::BTreeMap;

use heeler_rawdec::color::{invert3, mul3, srgb_from_camera, XYZ_FROM_SRGB};

fn files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let ext = name.rsplit('.').next().unwrap_or("").to_ascii_uppercase();
            if p.is_dir() {
                stack.push(p);
            } else if ["CR2", "CR3", "ARW", "NEF", "NRW", "RW2", "RAW", "RWL", "ORF", "ORI", "PEF", "SRW", "MRW", "IIQ", "CRW", "3FR", "FFF", "ERF", "MEF", "MOS", "KDC", "DCR", "TIF", "TIFF", "STI"].contains(&ext.as_str()) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// A four-color camera's XYZ-to-camera matrix (4 by 3) from LibRaw's
/// develop matrix (3 by 4) and daylight multipliers: the develop matrix's
/// pseudoinverse (its rows' sums 1), each row divided back by its
/// multiplier, then sRGB's primaries in XYZ; LibRaw's tables hold the
/// values to four places, to which they are rounded.
fn four_color_xyz(rgb_cam: &[[f32; 4]; 3], pre_mul: &[f32; 4]) -> Option<[[f64; 3]; 4]> {
    if pre_mul.iter().any(|&m| m <= 0.0) {
        return None;
    }
    let b: [[f64; 4]; 3] = rgb_cam.map(|r| r.map(|v| v as f64));
    let mut bbt = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            bbt[i][j] = (0..4).map(|k| b[i][k] * b[j][k]).sum();
        }
    }
    let inv = invert3(&bbt)?;
    let xyz_srgb = invert3(&XYZ_FROM_SRGB)?;
    let mut out = [[0.0; 3]; 4];
    for i in 0..4 {
        let cam_rgb: [f64; 3] = std::array::from_fn(|j| (0..3).map(|k| b[k][i] * inv[k][j]).sum::<f64>() / pre_mul[i] as f64);
        for j in 0..3 {
            out[i][j] = ((0..3).map(|k| cam_rgb[k] * xyz_srgb[k][j]).sum::<f64>() * 10000.0).round() / 10000.0;
        }
    }
    Some(out)
}

fn main() {
    let out = std::env::args().nth(1).expect("OUT.rs");
    let mut roots: Vec<std::path::PathBuf> = std::env::split_paths(&std::env::var_os("HEELER_RAW_CORPUS").expect("HEELER_RAW_CORPUS")).collect();
    roots.extend(std::env::args().skip(2).map(std::path::PathBuf::from));
    // (make, model) -> (XYZ-to-camera, a file), None where files disagree.
    let mut rows: BTreeMap<(String, String), Option<([[f64; 3]; 3], String)>> = BTreeMap::new();
    let mut no_matrix = std::collections::BTreeSet::new();
    // A four-color camera: (make, model) -> (XYZ-to-camera, 4 by 3, a file).
    let mut four_rows: BTreeMap<(String, String), Option<([[f64; 3]; 4], String)>> = BTreeMap::new();
    for path in roots.iter().flat_map(|r| files(r)) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Some((make, model)) = heeler_rawdec::dng::make_model(&bytes) else { continue };
        if heeler_rawdec::cameras::find_calibrated(&make, &model).is_some() {
            continue;
        }
        let Ok(f) = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()) else { continue };
        // A four-color camera's 3 by 4 matrix, back to its 4 by 3
        // XYZ-to-camera matrix (four_rows).
        if f.colors == 4 && f.filters >= 1000 && f.raw_color == 0 {
            if let Some(m) = four_color_xyz(&f.rgb_cam, &f.pre_mul) {
                let e = four_rows.entry((make, model)).or_insert_with(|| Some((m, path.display().to_string())));
                if let Some((have, _)) = e {
                    if (0..12).any(|k| (have[k / 3][k % 3] - m[k / 3][k % 3]).abs() > 1e-4) {
                        *e = None;
                    }
                }
            }
            continue;
        }
        if f.colors != 3 {
            continue;
        }
        // An image of three colors a pixel (filters 0) is recorded only
        // when LibRaw develops it in its own colors.
        if f.filters < 1000 && f.raw_color == 0 {
            continue;
        }
        if f.raw_color != 0 {
            no_matrix.insert((make, model));
            continue;
        }
        let rgb_cam = f.rgb_cam.map(|r| [r[0] as f64, r[1] as f64, r[2] as f64]);
        let Some(mut cam_rgb) = invert3(&rgb_cam) else { continue };
        // LibRaw scales each row so sRGB white reads as camera white, and
        // keeps what it divided by as its daylight multipliers: put the
        // scale back, so the matrix's daylight is LibRaw's.
        if f.pre_mul[..3].iter().any(|&m| m <= 0.0) {
            continue;
        }
        for (row, &m) in cam_rgb.iter_mut().zip(&f.pre_mul) {
            row.iter_mut().for_each(|v| *v /= m as f64);
        }
        let cam_xyz = mul3(&cam_rgb, &invert3(&XYZ_FROM_SRGB).unwrap());
        let e = rows.entry((make, model)).or_insert_with(|| Some((cam_xyz, path.display().to_string())));
        if let Some((m, _)) = e {
            if (0..9).any(|k| (m[k / 3][k % 3] - cam_xyz[k / 3][k % 3]).abs() > 1e-4 * m[k / 3][k % 3].abs().max(1.0)) {
                *e = None;
            }
        }
    }
    let mut text = String::from(
        "// Generated by crates/heeler-raw/examples/libraw_matrices.rs from the\n// matrices LibRaw opens the corpus's files with, for cameras the\n// calibration table lacks; do not edit by hand. Make, Model, and the\n// XYZ-to-camera matrix for D65; none for a camera LibRaw develops in its\n// own colors.\npub(crate) const LIBRAW_MATRICES: &[Calibration] = &[\n",
    );
    let mut kept = 0;
    for ((make, model), row) in &rows {
        let Some((m, sample)) = row else {
            eprintln!("left out, its files disagree: {make} {model}");
            continue;
        };
        // The develop matrix the row gives back, against LibRaw's.
        let back = srgb_from_camera(m).map(|(r, _)| r);
        eprintln!("{make} {model}: {sample}{}", if back.is_none() { " (singular)" } else { "" });
        let v: Vec<String> = m.iter().flatten().map(|x| format!("{x:.6}")).collect();
        text += &format!("    Calibration {{ make: {make:?}, model: {model:?}, illuminants: [21, 0], color_matrix: [Some([{}]), None], forward_matrix: [None, None], tables: false }},\n", v.join(", "));
        kept += 1;
    }
    // The cameras LibRaw develops without a matrix (their camera's colors
    // as they are): rows without one.
    for (make, model) in &no_matrix {
        eprintln!("LibRaw has no matrix: {make} {model}");
        text += &format!("    Calibration {{ make: {make:?}, model: {model:?}, illuminants: [0, 0], color_matrix: [None, None], forward_matrix: [None, None], tables: false }},\n");
    }
    text += "];\n";
    text += "// A four-color camera's XYZ-to-camera matrix for D65, four rows of three\n// (its colors in LibRaw's order), from the 3 by 4 matrix LibRaw opens its\n// files with.\npub(crate) const LIBRAW_MATRICES_4: &[(&str, &str, [f64; 12])] = &[\n";
    for ((make, model), row) in &four_rows {
        let Some((m, sample)) = row else {
            eprintln!("left out, its four-color files disagree: {make} {model}");
            continue;
        };
        eprintln!("{make} {model} (four colors): {sample}");
        let v: Vec<String> = m.iter().flatten().map(|x| format!("{x:.6}")).collect();
        text += &format!("    ({make:?}, {model:?}, [{}]),\n", v.join(", "));
    }
    text += "];\n";
    std::fs::write(&out, text).unwrap();
    eprintln!("{kept} cameras");
}
