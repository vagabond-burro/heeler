use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo::rerun-if-changed=export-resolution.json");
    let contract: serde_json::Value = serde_json::from_slice(
        &fs::read("export-resolution.json").expect("read export resolution contract")
    ).expect("valid export resolution JSON");
    let value = |key: &str| -> u32 {
        contract[key].as_u64().and_then(|v| u32::try_from(v).ok())
            .expect("export resolution values must be unsigned integers")
    };
    let default = value("defaultDpi");
    let max = value("maxDpi");
    assert!(default >= 1 && default <= max && max <= u16::MAX as u32,
        "export resolution must fit the JFIF density field");
    let source = format!(
        "/// Default print resolution from the shared export contract.\npub const DEFAULT_DPI: u32 = {default};\n\n/// Largest print resolution every supported container stores.\npub const MAX_DPI: u32 = {max};\n"
    );
    fs::write(PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"))
        .join("export_resolution.rs"), source).expect("write export resolution constants");
}