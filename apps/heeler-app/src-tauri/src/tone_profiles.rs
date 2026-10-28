//! Tone profile files: the Tone Profile's Custom curves as small YAML
//! files a person can keep, edit by hand and share.
//!
//! Files live in `<app data>/profiles/<Name>.heelerprofile`, beside
//! `presets` and `recipes`, and the profile menu lists every one beside
//! the built-in modes. Picking one copies its curve into the node's
//! `curve` param, so a document never depends on the file: it renders
//! the same on a machine that has never seen it.
//!
//! Import reads a profile file (and adds it to the folder), a 1D .cube,
//! a two-column text file, or the ProfileToneCurve of a DNG or camera
//! profile; the engine's tone_curve.rs turns each into a curve of the
//! one form. The YAML is recipe_files.rs's reader and writer, under
//! limits of its own.
//!
//! No code here deletes a file: saving over a name replaces the file
//! by a rename, and import never writes over one.

use std::path::{Path, PathBuf};

use heeler_engine::tone_curve::ToneCurve;
use serde_json::{json, Value};

use crate::recipe_files::{self, Limits};

pub const PROFILE_EXT: &str = "heelerprofile";
pub const PROFILE_VERSION: i64 = 1;
const MAX_BYTES: usize = 256 * 1024;
/// A camera profile or DNG is read for one tag; a DNG is a photograph,
/// so the cap is a photograph's.
const MAX_BINARY: u64 = 512 << 20;

const PROFILE_YAML: Limits = Limits { what: "tone profile", max_bytes: MAX_BYTES, max_text: 4096 };

const HEADER: &str = "\
# Heeler tone profile: a curve for the Tone Profile's Custom mode, from
# scene light in stops around middle gray to a display value from 0 to 1.
# Edit it in any text editor; Heeler reads it again when the profile menu
# opens. The user guide explains the fields: Source > Custom profiles.
";

const ORDER: &[&str] = &["heeler_profile", "name", "interp", "points"];

/// One file in the profiles folder, as the menu lists it: the curve, as
/// the JSON the node's `curve` param holds, or why it could not be read.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProfileEntry {
    pub path: String,
    pub file: String,
    pub name: String,
    pub curve: Option<String>,
    pub error: Option<String>,
}

/// What an import hands the panel: the curve to set, and where the
/// profile landed when the file was one to keep.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Imported {
    pub name: String,
    pub curve: String,
    pub saved: Option<String>,
}

/// The curve held to four decimals, which is finer than a display value
/// shows and keeps the file and the param short.
fn rounded(mut c: ToneCurve) -> ToneCurve {
    for p in &mut c.points {
        p[0] = (p[0] * 1e4).round() / 1e4;
        p[1] = (p[1] * 1e4).round() / 1e4;
    }
    c
}

/// The curve as a profile file.
pub fn write_profile(c: &ToneCurve) -> String {
    let num = |x: f32| json!((x as f64 * 1e4).round() / 1e4);
    let doc = json!({
        "heeler_profile": PROFILE_VERSION,
        "name": c.name,
        "interp": c.interp,
        "points": c.points.iter().map(|[x, y]| json!([num(*x), num(*y)])).collect::<Vec<_>>(),
    });
    recipe_files::write_yaml_value(HEADER, &doc, ORDER)
}

/// A profile file's curve, checked as the engine checks a param.
pub fn parse_profile(text: &str) -> Result<ToneCurve, String> {
    let doc = recipe_files::parse_yaml_value(text, &PROFILE_YAML).map_err(|e| e.to_string())?;
    let version = doc.get("heeler_profile").and_then(Value::as_i64).ok_or("not a tone profile file: no heeler_profile line")?;
    if version > PROFILE_VERSION {
        return Err("made by a newer Heeler: update the app to use this profile".into());
    }
    let name = doc.get("name").and_then(Value::as_str).filter(|n| !n.trim().is_empty()).ok_or("a tone profile needs a name")?;
    let mut c: ToneCurve = serde_json::from_value(json!({
        "name": name,
        "interp": doc.get("interp").cloned().unwrap_or(json!("smooth")),
        "points": doc.get("points").cloned().unwrap_or(Value::Null),
    }))
    .map_err(|e| format!("the points are not a list of [stops, display] pairs: {e}"))?;
    c.name = name.trim().to_string();
    c.checked()
}

fn read_text(p: &Path) -> Result<String, String> {
    let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len() as usize;
    if len > MAX_BYTES {
        return Err(format!("the file is {} KB; a curve file may be at most {} KB", len / 1024, MAX_BYTES / 1024));
    }
    String::from_utf8(std::fs::read(p).map_err(|e| e.to_string())?).map_err(|_| "the file is not UTF-8 text".to_string())
}

/// Any file the import takes, as a curve named after it (a profile
/// file keeps its own name), by its extension.
pub fn read_curve_file(p: &Path) -> Result<ToneCurve, String> {
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "Custom".into());
    let c = match ext.as_str() {
        PROFILE_EXT | "yaml" | "yml" => parse_profile(&read_text(p)?)?,
        "cube" => ToneCurve::from_cube_1d(&stem, &read_text(p)?)?,
        "txt" | "csv" => ToneCurve::from_two_columns(&stem, &read_text(p)?)?,
        "dng" | "dcp" => {
            let len = std::fs::metadata(p).map_err(|e| e.to_string())?.len();
            if len > MAX_BINARY {
                return Err("the file is too large to be a camera profile or DNG".into());
            }
            let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
            let pairs = heeler_io::dng_gain::profile_tone_curve(&bytes).ok_or("the file names no ProfileToneCurve")?;
            ToneCurve::from_linear_pairs(&stem, &pairs)?
        }
        _ => return Err(format!("Heeler reads tone curves from .{PROFILE_EXT}, .cube, .txt, .csv, .dng and .dcp files")),
    };
    Ok(rounded(c))
}

/// Every profile file in `base`, sorted by name; dot files left out.
pub fn list_profiles(base: &Path) -> Vec<ProfileEntry> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(base) else { return out };
    for e in entries.flatten() {
        let p = e.path();
        let file = e.file_name().to_string_lossy().to_string();
        if file.starts_with('.') || p.extension().and_then(|x| x.to_str()) != Some(PROFILE_EXT) {
            continue;
        }
        let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let (name, curve, error) = match read_text(&p).and_then(|t| parse_profile(&t)) {
            Ok(c) => (c.name.clone(), Some(c.to_json()), None),
            Err(e) => (stem.clone(), None, Some(e)),
        };
        out.push(ProfileEntry { path: p.to_string_lossy().to_string(), file: stem, name, curve, error });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.file.cmp(&b.file)));
    out
}

/// Writes the curve as `<name>.heelerprofile`, replacing a profile of
/// the same name; the text is read back before it lands.
pub fn save_profile(base: &Path, curve: &str, name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("a tone profile needs a name".into());
    }
    let mut c = ToneCurve::from_json(curve)?;
    c.name = name.to_string();
    let text = write_profile(&rounded(c));
    parse_profile(&text).map_err(|e| format!("Heeler wrote a profile it cannot read back ({e}); nothing was saved"))?;
    let dest = base.join(format!("{}.{PROFILE_EXT}", recipe_files::safe_file_name(name)));
    recipe_files::write_text(&dest, &text)?;
    Ok(dest.to_string_lossy().to_string())
}

/// `base/stem.heelerprofile`, or `stem 2`, `stem 3` when taken.
fn free_name(base: &Path, stem: &str) -> PathBuf {
    let mut dest = base.join(format!("{stem}.{PROFILE_EXT}"));
    let mut k = 2;
    while dest.exists() {
        dest = base.join(format!("{stem} {k}.{PROFILE_EXT}"));
        k += 1;
    }
    dest
}

/// Reads a picked file. A profile file is copied into the folder as the
/// person wrote it, comments and all, under a free name; any other kind
/// is a curve for the panel to set, to save as a profile if wanted.
pub fn import_file(base: &Path, p: &Path) -> Result<Imported, String> {
    let c = read_curve_file(p)?;
    let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
    let saved = if matches!(ext.as_str(), PROFILE_EXT | "yaml" | "yml") {
        let dest = free_name(base, &recipe_files::safe_file_name(&c.name));
        recipe_files::write_text(&dest, &read_text(p)?)?;
        Some(dest.to_string_lossy().to_string())
    } else {
        None
    };
    Ok(Imported { name: c.name.clone(), curve: c.to_json(), saved })
}

// --- Commands ------------------------------------------------------------

fn profiles_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map(|d| d.join("profiles")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tone_profile_list(app: tauri::AppHandle) -> Result<Vec<ProfileEntry>, String> {
    let base = profiles_base(&app)?;
    tauri::async_runtime::spawn_blocking(move || list_profiles(&base)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tone_profile_save(app: tauri::AppHandle, curve: String, name: String) -> Result<String, String> {
    save_profile(&profiles_base(&app)?, &curve, &name)
}

#[tauri::command]
pub async fn tone_profile_import(app: tauri::AppHandle) -> Result<Option<Imported>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter("Tone curve", &[PROFILE_EXT, "yaml", "yml", "cube", "txt", "csv", "dng", "dcp"])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let base = profiles_base(&app)?;
    tauri::async_runtime::spawn_blocking(move || import_file(&base, &path)).await.map_err(|e| e.to_string())?.map(Some)
}

#[tauri::command]
pub async fn tone_profile_export(app: tauri::AppHandle, curve: String, name: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let mut c = ToneCurve::from_json(&curve)?;
    if !name.trim().is_empty() {
        c.name = name.trim().to_string();
    }
    let Some(fp) = app
        .dialog()
        .file()
        .set_file_name(format!("{}.{PROFILE_EXT}", recipe_files::safe_file_name(&c.name)))
        .add_filter("Heeler tone profile", &[PROFILE_EXT])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let dest = fp.into_path().map_err(|e| e.to_string())?;
    recipe_files::write_text(&dest, &write_profile(&rounded(c)))?;
    Ok(Some(dest.to_string_lossy().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURVE: &str = r#"{"name":"Soft","interp":"smooth","points":[[-8,0],[-2,0.2],[0,0.4512],[2.4739,0.98]]}"#;

    #[test]
    fn a_saved_profile_lists_and_reads_back_as_the_same_curve() {
        let dir = tempfile::tempdir().unwrap();
        let path = save_profile(dir.path(), CURVE, "Soft Fade").unwrap();
        assert!(path.ends_with("Soft Fade.heelerprofile"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("# Heeler tone profile"));
        assert!(text.contains("heeler_profile: 1\nname: Soft Fade\ninterp: smooth\npoints:\n  - [-8, 0]\n"), "{text}");
        let listed = list_profiles(dir.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "Soft Fade");
        let back = ToneCurve::from_json(listed[0].curve.as_deref().unwrap()).unwrap();
        let mut want = ToneCurve::from_json(CURVE).unwrap();
        want.name = "Soft Fade".into();
        assert_eq!(back, want);
        // Saving the name again replaces it rather than adding a second.
        save_profile(dir.path(), CURVE, "Soft Fade").unwrap();
        assert_eq!(list_profiles(dir.path()).len(), 1);
        assert!(save_profile(dir.path(), CURVE, "  ").is_err());
    }

    #[test]
    fn a_hand_edited_profile_reads_and_a_broken_one_lists_with_its_reason() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("Mine.heelerprofile"),
            "# my curve\nheeler_profile: 1\nname: Mine\npoints:\n  - [-6, 0.01]  # deep shadow\n  - [0, 0.5]\n  - [3, 1]\n",
        )
        .unwrap();
        std::fs::write(dir.path().join("Broken.heelerprofile"), "heeler_profile: 1\nname: Broken\npoints:\n  - [0, 0.5]\n").unwrap();
        std::fs::write(dir.path().join("Newer.heelerprofile"), "heeler_profile: 9\nname: Newer\npoints: []\n").unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a profile").unwrap();
        let listed = list_profiles(dir.path());
        let names: Vec<&str> = listed.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Broken", "Mine", "Newer"]);
        let mine = ToneCurve::from_json(listed[1].curve.as_deref().unwrap()).unwrap();
        assert_eq!(mine.interp, "smooth");
        assert_eq!(mine.points[1], [0.0, 0.5]);
        assert!(listed[0].error.as_deref().unwrap().contains("two points"));
        assert!(listed[2].error.as_deref().unwrap().contains("newer Heeler"));
    }

    #[test]
    fn import_reads_every_kind_and_keeps_only_profile_files() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().join("profiles");
        let src = dir.path().join("in");
        std::fs::create_dir_all(&src).unwrap();
        // A profile file lands in the folder, comments and all.
        let profile = src.join("Shared.yaml");
        std::fs::write(&profile, format!("# from a friend\n{}", write_profile(&ToneCurve::from_json(CURVE).unwrap()))).unwrap();
        let got = import_file(&base, &profile).unwrap();
        assert_eq!(got.name, "Soft");
        let saved = got.saved.unwrap();
        assert!(saved.ends_with("Soft.heelerprofile"));
        assert!(std::fs::read_to_string(&saved).unwrap().starts_with("# from a friend"));
        // A second import of the same file takes a free name.
        assert!(import_file(&base, &profile).unwrap().saved.unwrap().ends_with("Soft 2.heelerprofile"));
        // The other kinds are curves for the panel, not files to keep.
        let text = src.join("Two.txt");
        std::fs::write(&text, "-8 0\n0 0.45\n2.5 1\n").unwrap();
        let two = import_file(&base, &text).unwrap();
        assert!(two.saved.is_none());
        assert_eq!(two.name, "Two");
        let cube = src.join("Lift.cube");
        std::fs::write(&cube, "LUT_1D_SIZE 2\n0.1 0.1 0.1\n1 1 1\n").unwrap();
        let lifted = ToneCurve::from_json(&import_file(&base, &cube).unwrap().curve).unwrap();
        assert!(lifted.eval(-30.0) > 0.09, "the LUT's black is 0.1");
        let dng = src.join("Phone.dng");
        std::fs::write(&dng, b"II*\0\x08\0\0\0\0\0\0\0\0\0").unwrap();
        assert!(import_file(&base, &dng).unwrap_err().contains("ProfileToneCurve"));
        assert!(import_file(&base, &src.join("x.png")).is_err());
        assert_eq!(list_profiles(&base).len(), 2);
    }
}
