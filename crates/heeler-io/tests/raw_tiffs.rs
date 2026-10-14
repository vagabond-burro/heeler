//! Camera raws saved as .TIF (Kodak DCS, Canon EOS-1D, EOS-1Ds and
//! D2000, Phase One backs) open as the photograph, not as the thumbnail
//! that is their first TIFF image. Opt-in, against a raw.pixls.us copy:
//!   HEELER_PIXLS=/Volumes/STORAGE/RAW/pixls cargo test --release -p heeler-io --features libraw --test raw_tiffs -- --ignored --nocapture

#![cfg(feature = "libraw")]

use std::path::PathBuf;

/// Every .TIF in raw.pixls.us, with the size LibRaw develops it to.
const FILES: [(&str, (u32, u32)); 20] = [
    ("Canon/EOS D2000C/RAW_CANON_D2000.TIF", (1736, 1160)),
    ("Canon/EOS-1D/B53A0011-20171118-ss200-ap2.8-fl50-iso200.TIF", (2496, 1662)),
    ("Canon/EOS-1Ds/IMG-27780.TIF", (4082, 2718)),
    ("Kodak/DCS460D/RAW_KODAK_DCS460D_FILEVERSION_3.TIF", (3068, 2048)),
    ("Kodak/DCS520C/23HK3627.TIF", (1736, 1160)),
    ("Kodak/DCS560C/RAW_KODAK_DCS560C.TIF", (3048, 2016)),
    ("Kodak/EOS DCS 1/RAW_CANON_DCS1.TIF", (3068, 2048)),
    ("Kodak/EOS DCS 3/DCS00240.TIF", (1276, 1024)),
    ("Phase One/H 25/H25_IT8.7-2_Card.TIF", (5455, 4096)),
    ("Phase One/IQ140/Phase_One_IQ140_sample_files_04_Diciembre_2017_004_IIQ_L.TIF", (7320, 5484)),
    ("Phase One/IQ140/Phase_One_IQ140_sample_files_04_Diciembre_2017_005_IIQ_S.TIF", (7320, 5484)),
    ("Phase One/IQ140/Phase_One_IQ140_sample_files_04_Diciembre_2017_010_Sensor+_IIQ_L.TIF", (3658, 2740)),
    ("Phase One/IQ140/Phase_One_IQ140_sample_files_04_Diciembre_2017_011_Sensor+_IIQ_S.TIF", (3658, 2740)),
    ("Phase One/P20+/CF051552.TIF", (4093, 4096)),
    ("Phase One/P20+/CF051553.TIF", (4093, 4096)),
    ("Phase One/P25/CF082161.TIF", (5455, 4096)),
    ("Phase One/P25/CF082166.TIF", (5455, 4096)),
    ("Phase One/P30/CF098736.TIF", (6525, 4904)),
    ("Phase One/P45/230215_3809.TIF", (7245, 5444)),
    ("Phase One/P45/230215_3810.TIF", (7245, 5444)),
];

#[test]
#[ignore]
fn a_raw_saved_as_a_tif_opens_as_the_photograph() {
    let Some(root) = std::env::var_os("HEELER_PIXLS").map(PathBuf::from) else {
        eprintln!("HEELER_PIXLS not set; skipping");
        return;
    };
    for (name, size) in FILES {
        let path = root.join(name);
        let bytes = std::fs::read(&path).unwrap();
        assert!(heeler_io::is_raw_path(&path) && heeler_io::is_raw_file(&path, &bytes), "{name}");
        // The header and the develop agree, an upright frame either way.
        let header = heeler_io::picture_dimensions(&path, &bytes).unwrap();
        let img = heeler_io::decode_any(&path).unwrap();
        assert_eq!((img.width as u32, img.height as u32), header, "{name}");
        assert_eq!(header.0.max(header.1), size.0.max(size.1), "{name}");
        let thumb = heeler_io::decode_thumbnail(&path).unwrap();
        assert!(thumb.width.max(thumb.height) >= 600, "{name}: a {}x{} thumbnail", thumb.width, thumb.height);
        println!("{name}: {}x{}, thumbnail {}x{}", img.width, img.height, thumb.width, thumb.height);
    }
}
