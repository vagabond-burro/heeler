//! Builds heeler-rawdec's table of camera geometry (src/geometry_table.rs)
//! for the raw formats whose files do not state it the way LibRaw reads
//! them: for every CR2, CR3, ARW, NEF, RW2, ORF, PEF, SRW and MRW (and
//! their variants: NRW, RAW, RWL, ORI) of the corpus at
//! HEELER_RAW_CORPUS (and of any further folders given after OUT.rs, such
//! as a second corpus), the image area LibRaw develops (its margins and
//! size within the raw frame), the CFA colors at that area's top left, and
//! its white level, as LibRaw reads them when it opens the file, keyed by
//! Make, Model and the raw frame's size. Heeler keeps LibRaw's image size for these
//! formats so a document's crop and strokes, stored as fractions of the
//! image, stay where they were (the owner's decision of 2026-10-20). A
//! camera whose files disagree is left out and reported, and so is one
//! whose area LibRaw takes larger than the sensor data a Sony file states
//! (tag 0x7038), a guard: heeler-raw's open keeps LibRaw's area to that
//! size (open_buffer), so no row should take in a frame's padding.
//!
//!   cargo run --release -p heeler-raw --example geometry -- OUT.rs [folders]
use std::collections::BTreeMap;

use heeler_rawdec::tiff::Tiff;

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
            } else if ["CR2", "CR3", "ARW", "NEF", "NRW", "RW2", "RAW", "RWL", "ORF", "ORI", "PEF", "SRW", "MRW"].contains(&ext.as_str()) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Make and Model as IFD0 gives them (a CR3's in its CMT1 box).
fn make_model(bytes: &[u8]) -> Option<(String, String)> {
    if heeler_rawdec::cr3::is_cr3(bytes) {
        return heeler_rawdec::cr3::make_model(bytes);
    }
    if heeler_rawdec::rw2::is_rw2(bytes) {
        return heeler_rawdec::rw2::make_model(bytes);
    }
    if heeler_rawdec::orf::is_orf(bytes) {
        return heeler_rawdec::orf::make_model(bytes);
    }
    if heeler_rawdec::mrw::is_mrw(bytes) {
        return heeler_rawdec::mrw::make_model(bytes);
    }
    let t = Tiff::new(bytes)?;
    let ifd0 = t.ifds().into_iter().next()?;
    let ascii = |tag| ifd0.get(tag).and_then(|e| t.ascii(&e));
    Some((ascii(271)?, ascii(272)?))
}

/// The sensor data's width and height a Sony file states in its raw
/// directory (0x7038), inside the frame's padding.
fn stated_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let t = Tiff::new(bytes)?;
    let v = t.ifds().into_iter().find_map(|i| i.get(0x7038).and_then(|e| t.uints(&e)))?;
    Some((*v.first()?, *v.get(1)?))
}

fn main() {
    let out = std::env::args().nth(1).expect("OUT.rs");
    let mut roots = vec![std::path::PathBuf::from(std::env::var_os("HEELER_RAW_CORPUS").expect("HEELER_RAW_CORPUS"))];
    roots.extend(std::env::args().skip(2).map(std::path::PathBuf::from));
    // (make, model, raw width, raw height) -> (top, left, width, height, colors, maximum, sample)
    type Row = (u32, u32, u32, u32, [u8; 4], u32);
    let mut rows: BTreeMap<(String, String, u32, u32), (Row, String)> = BTreeMap::new();
    let mut disagree = std::collections::BTreeSet::new();
    // A NEF's white level varies with its samples' depth: (make, model,
    // depth) -> LibRaw's level, None where the files disagree.
    let mut nef_white: BTreeMap<(String, String, u32), Option<u32>> = BTreeMap::new();
    // An ORF, NEF or RW2 camera's black level for files that state none:
    // (make, model) -> LibRaw's, red, the green on red's row, the other
    // green, blue; None where the files disagree.
    let mut black_of: BTreeMap<(String, String), Option<[u32; 4]>> = BTreeMap::new();
    let mut padded = std::collections::BTreeSet::new();
    for (root, path) in roots.iter().flat_map(|r| files(r).into_iter().map(move |p| (r, p))) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Some((make, model)) = make_model(&bytes) else { continue };
        let Ok(f) = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()) else { continue };
        // Bayer images only (a 2 by 2 pattern repeated down the rows).
        if f.filters < 1000 || f.colors != 3 {
            continue;
        }
        if heeler_rawdec::nef::is_nef(&bytes) {
            if let Some(depth) = heeler_rawdec::nef::depth(&bytes) {
                let e = nef_white.entry((make.clone(), model.clone(), depth)).or_insert(Some(f.maximum));
                if *e != Some(f.maximum) {
                    *e = None;
                }
            }
        }
        if heeler_rawdec::orf::is_orf(&bytes) || heeler_rawdec::nef::is_nef(&bytes) || heeler_rawdec::rw2::is_rw2(&bytes) {
            // LibRaw's per-color levels: red, green, blue, the other green.
            let b = if f.cblack[4] == 0 && f.cblack[5] == 0 { Some([0, 1, 3, 2].map(|i| f.black + f.cblack[i])) } else { None };
            let e = black_of.entry((make.clone(), model.clone())).or_insert(b);
            if *e != b {
                *e = None;
            }
        }
        let color = |r: u32, c: u32| ((f.filters >> ((((r << 1) & 14) | (c & 1)) << 1)) & 3) as u8;
        // LibRaw's fourth color is the second green.
        let g = |v: u8| if v == 3 { 1 } else { v };
        let colors = [g(color(0, 0)), g(color(0, 1)), g(color(1, 0)), g(color(1, 1))];
        let row: Row = (f.top_margin, f.left_margin, f.width, f.height, colors, f.maximum);
        if stated_size(&bytes).is_some_and(|(w, h)| f.width > w || f.height > h) {
            padded.insert((make.clone(), model.clone()));
        }
        let key = (make, model, f.raw_width, f.raw_height);
        let name = path.strip_prefix(root).unwrap_or(&path).display().to_string();
        match rows.get(&key) {
            Some((r, _)) if *r != row => {
                // White levels a file states (Sony's) vary by file; keep the
                // area, mark the level as the file's (0).
                if (r.0, r.1, r.2, r.3, r.4) == (row.0, row.1, row.2, row.3, row.4) {
                    rows.get_mut(&key).unwrap().0 .5 = 0;
                } else {
                    disagree.insert(key.clone());
                }
            }
            Some(_) => {}
            None => {
                rows.insert(key, (row, name));
            }
        }
    }
    for k in &disagree {
        eprintln!("left out, its files disagree: {k:?}");
        rows.remove(k);
    }
    for (make, model) in &padded {
        eprintln!("left out, LibRaw's area takes in the frame's padding: {make} {model}");
        rows.retain(|k, _| (&k.0, &k.1) != (make, model));
    }
    let mut src = String::from(
        "// Generated by crates/heeler-raw/examples/geometry.rs from LibRaw's\n\
         // reading of the corpus's CR2, CR3, ARW, NEF, RW2 and ORF files; do not edit by hand.\n\
         // Make, Model, raw width and height, then the image area's top, left,\n\
         // width and height, the CFA colors at its top left (row by row, 0\n\
         // red, 1 green, 2 blue) and the white level (0: the file's own).\n\
         pub(crate) const GEOMETRY: &[Geometry] = &[\n",
    );
    for ((make, model, rw, rh), ((top, left, w, h, colors, max), _)) in &rows {
        src += &format!(
            "    Geometry {{ make: {make:?}, model: {model:?}, raw: ({rw}, {rh}), top: {top}, left: {left}, width: {w}, height: {h}, colors: {colors:?}, white: {max} }},\n"
        );
    }
    src += "];\n";
    src += "// A NEF camera's white level for each depth of its samples, as LibRaw\n\
            // reads it (the cameras whose files agree).\n\
            pub(crate) const NEF_WHITE: &[(&str, &str, u32, u32)] = &[\n";
    for ((make, model, depth), white) in &nef_white {
        match white {
            Some(w) => src += &format!("    ({make:?}, {model:?}, {depth}, {w}),\n"),
            None => eprintln!("left out, its {depth}-bit NEFs' white levels disagree: {make} {model}"),
        }
    }
    src += "];\n";
    src += "// An ORF, NEF or RW2 camera's black level as LibRaw reads it (red, the green\n\
            // on red's row, the other green, blue), the cameras whose files agree,\n\
            // for files that state none.\n\
            pub(crate) const BLACK: &[(&str, &str, [u32; 4])] = &[\n";
    for ((make, model), black) in &black_of {
        match black {
            Some(b) => src += &format!("    ({make:?}, {model:?}, {b:?}),\n"),
            None => eprintln!("left out, its files' black levels disagree: {make} {model}"),
        }
    }
    src += "];\n";
    std::fs::write(&out, src).unwrap();
    eprintln!("{} camera sizes, {} left out, {} cameras padded", rows.len(), disagree.len(), padded.len());
}
