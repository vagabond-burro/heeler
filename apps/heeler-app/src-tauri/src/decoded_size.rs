//! The pixel scale reads the photograph's decoded size once a full
//! decode has found it (the groups-scale review's R7).
use super::*;

fn catalog_with(dir: &Path, header: (u32, u32)) -> (Catalog, String, PathBuf) {
    let c = Catalog::open_in_memory().unwrap();
    let folder = c.add_folder(dir).unwrap();
    let path = dir.join("P1551369.RW2");
    std::fs::write(&path, b"stand-in").unwrap();
    c.add_image("img_own", &path, Some(folder)).unwrap();
    c.set_dimensions("img_own", header.0, header.1).unwrap();
    (c, "img_own".into(), path)
}

#[test]
fn a_decode_beats_the_header_under_its_own_options() {
    let dir = tempfile::tempdir().unwrap();
    let (c, id, path) = catalog_with(dir.path(), (6000, 4000));
    let opts = heeler_io::RawSourceOpts::default();
    let key = managed_source_key_for_path(Some(path.clone()), &id, opts);
    // The header stands until a decode happened.
    assert_eq!(recorded_short(&c, &id, &key), Some(4000.0));
    c.set_decoded_dimensions(&id, &key, 6024, 4016).unwrap();
    assert_eq!(recorded_short(&c, &id, &key), Some(4016.0));
    // Another develop option is another decode: the header again.
    let other = heeler_io::RawSourceOpts { camera_wb: !opts.camera_wb, ..opts };
    let other_key = managed_source_key_for_path(Some(path.clone()), &id, other);
    assert_ne!(key, other_key);
    assert_eq!(recorded_short(&c, &id, &other_key), Some(4000.0));
    // A replaced file is a new source key too (its length changed).
    std::fs::write(&path, b"a different photograph").unwrap();
    let replaced = managed_source_key_for_path(Some(path), &id, opts);
    assert_eq!(recorded_short(&c, &id, &replaced), Some(4000.0));
}

/// The jaguar: its header says 4000 on the short side, a full decode
/// 4016. Skipped when the photograph is not on this machine.
#[test]
fn the_jaguar_reads_4016_after_one_full_decode() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let jaguar = PathBuf::from(home).join("Photography/2025-11-23/P1551369.RW2");
    if !jaguar.is_file() {
        eprintln!("skipped: {} is not here", jaguar.display());
        return;
    }
    let (hw, hh) = heeler_io::source_dimensions(&std::fs::read(&jaguar).unwrap()).unwrap();
    assert_eq!(hw.min(hh), 4000, "the header's short side");
    let c = Catalog::open_in_memory().unwrap();
    let folder = c.add_folder(jaguar.parent().unwrap()).unwrap();
    c.add_image("img_jaguar", &jaguar, Some(folder)).unwrap();
    c.set_dimensions("img_jaguar", hw, hh).unwrap();
    let opts = heeler_io::RawSourceOpts::default();
    let key = managed_source_key_for_path(Some(jaguar.clone()), "img_jaguar", opts);
    assert_eq!(recorded_short(&c, "img_jaguar", &key), Some(4000.0));
    // What full_source records after its decode.
    let full = heeler_io::decode_any_with(&jaguar, opts).unwrap();
    c.set_decoded_dimensions("img_jaguar", &key, full.width as u32, full.height as u32).unwrap();
    assert_eq!(recorded_short(&c, "img_jaguar", &key), Some(4016.0));
    // And a 2048 preview's pixel dial scale moves with it.
    let preview = ImageBuf::new(1365, 2048);
    assert!((px_scale_for(&preview, recorded_short(&c, "img_jaguar", &key)) - 1365.0 / 4016.0).abs() < 1e-6);
}
