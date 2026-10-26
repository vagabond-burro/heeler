//! Builds heeler-rawdec's table of camera geometry (src/geometry_table.rs)
//! for the raw formats whose files do not state it the way LibRaw reads
//! them: for every CR2, CR3, ARW, NEF, RW2, ORF, PEF, SRW, MRW, IIQ, CRW, RAF, 3FR and FFF
//! (and their variants: NRW, RAW, RWL, ORI), and every headerless file of a
//! size heeler-rawdec knows, of the corpus at
//! HEELER_RAW_CORPUS (a list of folders, as PATH is, and of any further folders given after OUT.rs, such
//! as a second corpus), the image area LibRaw develops (its margins and
//! size within the raw frame), the CFA colors at that area's top left (an
//! X-Trans sensor's first 2 by 2 of its 6 by 6), and
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
            } else if ["CR2", "CR3", "ARW", "NEF", "NRW", "RW2", "RAW", "RWL", "ORF", "ORI", "PEF", "SRW", "MRW", "IIQ", "CRW", "RAF", "DNG", "3FR", "FFF", "ERF", "KDC", "MOS", "MEF", "STI"].contains(&ext.as_str()) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
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
    let mut roots: Vec<std::path::PathBuf> = std::env::split_paths(&std::env::var_os("HEELER_RAW_CORPUS").expect("HEELER_RAW_CORPUS")).collect();
    roots.extend(std::env::args().skip(2).map(std::path::PathBuf::from));
    // (make, model, raw width, raw height) -> (top, left, width, height, colors, maximum, sample)
    type Row = (u32, u32, u32, u32, [u8; 4], u32);
    let mut rows: BTreeMap<(String, String, u32, u32), (Row, String)> = BTreeMap::new();
    let mut disagree = std::collections::BTreeSet::new();
    // A NEF's or RAF's white level varies with its samples' depth: (make,
    // model, depth) -> LibRaw's level, None where the files disagree.
    let mut nef_white: BTreeMap<(String, String, u32), Option<u32>> = BTreeMap::new();
    // An ORF, NEF or RW2 camera's black level for files that state none:
    // (make, model) -> LibRaw's, red, the green on red's row, the other
    // green, blue; None where the files disagree.
    let mut black_of: BTreeMap<(String, String), Option<[u32; 4]>> = BTreeMap::new();
    let mut padded = std::collections::BTreeSet::new();
    // A camera's DNG whose stated image area (the whole frame if none)
    // LibRaw develops smaller, its own table's area:
    // (make, model, width, height) -> the area, None where files disagree.
    let mut dng_rows: BTreeMap<(String, String, u32, u32), Option<Row>> = BTreeMap::new();
    // An image of three samples a pixel: (make, model, raw width, raw
    // height) -> LibRaw's area and white level, None where files disagree.
    let mut rgb_rows: BTreeMap<(String, String, u32, u32), Option<Row>> = BTreeMap::new();
    for (root, path) in roots.iter().flat_map(|r| files(r).into_iter().map(move |p| (r, p))) {
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Some((make, model)) = heeler_rawdec::dng::make_model(&bytes) else { continue };
        let Ok(f) = heeler_raw::linear_dng::libraw_facts(&bytes, heeler_raw::DevelopOpts::default()) else { continue };
        // Bayer images (a 2 by 2 pattern repeated down the rows), X-Trans
        // ones (6 by 6), and images of three samples a pixel (a Canon sRAW,
        // a Sony M or S size), whose areas are a table of their own.
        // And a monochrome sensor's frame (no CFA, one color), in the main
        // table, its colors 0.
        let mono = f.filters == 0 && f.colors == 1 && !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dng"));
        if mono {
            let row: Row = (f.top_margin, f.left_margin, f.width, f.height, [0; 4], f.maximum);
            let key = (make.clone(), model.clone(), f.raw_width, f.raw_height);
            match rows.get(&key) {
                Some((r, _)) if *r != row => {
                    disagree.insert(key);
                }
                Some(_) => {}
                None => {
                    rows.insert(key, (row, path.display().to_string()));
                }
            }
            continue;
        }
        if !(f.filters >= 1000 || f.filters == 9 || f.filters == 0) || f.colors != 3 {
            continue;
        }
        if f.filters == 0 && !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dng")) {
            let row: Row = (f.top_margin, f.left_margin, f.width, f.height, [0; 4], f.maximum);
            let e = rgb_rows.entry((make.clone(), model.clone(), f.raw_width, f.raw_height)).or_insert(Some(row));
            if *e != Some(row) {
                *e = None;
            }
            continue;
        }
        // A DNG's area as the file states it (Dng::open applies these rows).
        let named_dng = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dng"));
        let stated = if named_dng { heeler_rawdec::dng::Dng::open(&bytes).ok().filter(|d| d.is_dng()).and_then(|_| heeler_rawdec::dng::Dng::parse(&bytes).ok()) } else { None };
        if named_dng && std::env::var_os("GEOMETRY_DEBUG").is_some() {
            eprintln!("{}: {:?} libraw {}x{} at ({},{}) raw {}x{} filters {}", path.display(), stated.as_ref().map(|d| (d.width, d.height, d.active, d.cfa_dim)), f.width, f.height, f.top_margin, f.left_margin, f.raw_width, f.raw_height, f.filters);
        }
        if named_dng {
            let Some(d) = stated else { continue };
            let (w, h) = (d.width as u32, d.height as u32);
            // LibRaw's area inside the stated one (the whole frame where
            // the file states none) and not the same, on the same frame.
            let (t, l, b, r) = d.active;
            let (ft, fl) = (f.top_margin as usize, f.left_margin as usize);
            let inside = ft >= t && fl >= l && ft + f.height as usize <= b && fl + f.width as usize <= r && (ft - t) % 2 == 0 && (fl - l) % 2 == 0;
            let differs = (ft, fl, ft + f.height as usize, fl + f.width as usize) != d.active;
            if (f.raw_width, f.raw_height) == (w, h) && inside && differs && f.filters >= 1000 && d.cfa_dim == (2, 2) {
                let color = |r: u32, c: u32| ((f.filters >> ((((r << 1) & 14) | (c & 1)) << 1)) & 3) as u8;
                let g = |v: u8| if v == 3 { 1 } else { v };
                let row: Row = (f.top_margin, f.left_margin, f.width, f.height, [g(color(0, 0)), g(color(0, 1)), g(color(1, 0)), g(color(1, 1))], 0);
                let e = dng_rows.entry((d.make.clone(), d.model.clone(), w, h)).or_insert(Some(row));
                if *e != Some(row) {
                    *e = None;
                }
            }
            continue;
        }
        let xtrans = if f.filters == 9 { heeler_raw::linear_dng::libraw_xtrans(&bytes).ok().flatten() } else { None };
        if heeler_rawdec::nef::is_nef(&bytes) || heeler_rawdec::raf::is_raf(&bytes) {
            if let Some(depth) = heeler_rawdec::nef::depth(&bytes).or_else(|| heeler_rawdec::raf::depth(&bytes)) {
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
        // An X-Trans area's first 2 by 2 of its 6 by 6.
        let colors = match xtrans {
            Some(x) => [x[0][0], x[0][1], x[1][0], x[1][1]],
            None => [g(color(0, 0)), g(color(0, 1)), g(color(1, 0)), g(color(1, 1))],
        };
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
                } else if (r.0, r.1, r.2, r.3, r.5) == (row.0, row.1, row.2, row.3, row.5) && heeler_rawdec::rw2::stated_cfa(&bytes).is_some() {
                    // An RW2 states its CFA, which rw2.rs takes: files that
                    // differ only there keep the row.
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
    src += "// A camera's DNG whose stated image area (the whole frame where it states\n\
            // none) LibRaw develops smaller, the area LibRaw develops (its own table\n\
            // for the camera); the white level is the file's own.\n\
            pub(crate) const DNG_GEOMETRY: &[Geometry] = &[\n";
    for ((make, model, rw, rh), row) in &dng_rows {
        match row {
            Some((top, left, w, h, colors, _)) => src += &format!(
                "    Geometry {{ make: {make:?}, model: {model:?}, raw: ({rw}, {rh}), top: {top}, left: {left}, width: {w}, height: {h}, colors: {colors:?}, white: 0 }},\n"
            ),
            None => eprintln!("left out, its DNGs' areas disagree: {make} {model}"),
        }
    }
    src += "];\n";
    src += "// An image of three samples a pixel (a Canon sRAW or mRAW, a Sony M or S\n\
            // size): the area LibRaw develops of its frame and its white level.\n\
            pub(crate) const RGB_GEOMETRY: &[Geometry] = &[\n";
    for ((make, model, rw, rh), row) in &rgb_rows {
        match row {
            Some((top, left, w, h, _, max)) => src += &format!(
                "    Geometry {{ make: {make:?}, model: {model:?}, raw: ({rw}, {rh}), top: {top}, left: {left}, width: {w}, height: {h}, colors: [0, 0, 0, 0], white: {max} }},\n"
            ),
            None => eprintln!("left out, its three-color files' areas disagree: {make} {model}"),
        }
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
