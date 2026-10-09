//! Local edit recovery. Only complete, synchronized staging directories are published.
//! Photographs (including baked composites) are read for checksums, never written.
use heeler_catalog::Catalog;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

const SCHEMA: u32 = 1;
const OPTIONAL: &[&str] = &[
    "previews",
    "proxies",
    "thumbnails",
    "depth rasters",
    "matte rasters",
];

/// Whether recovery bundles carry the pictures Layer via Copy and Bake
/// Warp keep (Preferences > Backup, Keep baked pictures in backups;
/// 2026-10-01: "I would say alert the user and give the choice to them.
/// I would lean towards it being on by default"). Read from the
/// catalog's saved settings, which a bundle captures after it saves
/// them; anything unreadable or absent is on.
pub(crate) fn keeps_finish_pictures(catalog: &Catalog) -> bool {
    catalog
        .meta("ui_settings")
        .ok()
        .flatten()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|v| v.get("prefs")?.get("keepBakedInBackups")?.as_bool())
        .unwrap_or(true)
}
fn kept_by_default() -> bool {
    true
}
/// The line a bundle without its Finish pictures carries, so the report
/// says what is left out and what that means.
fn left_out_note(count: usize) -> String {
    format!(
        "{count} Layer via Copy or Bake Warp picture{} not in this bundle (Keep baked pictures in backups is off): read where Heeler keeps {}; a layer whose picture is lost comes back without it",
        if count == 1 { " is" } else { "s are" },
        if count == 1 { "it" } else { "them" },
    )
}
fn missing_note(path: &str) -> String {
    format!("{path}: this Layer via Copy or Bake Warp picture is missing and not in the bundle; its layer comes back pointing at it and shows it as missing")
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Asset {
    pub path: String,
    pub references: Vec<String>,
    pub bytes: Option<u64>,
    pub sha256: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Manifest {
    pub schema: u32,
    pub catalog_schema: i64,
    pub app_version: String,
    pub source_catalog: String,
    pub source_app_data: String,
    pub files: Vec<Entry>,
    pub assets: Vec<Asset>,
    pub optional_caches_omitted: Vec<String>,
    pub images: usize,
    pub graphs: usize,
    pub takes: usize,
    pub presets: usize,
    /// Whether the bundle carries the Finish pictures its edits read
    /// (vision/layercopies). Off (keeps_finish_pictures), they are
    /// inventoried by path and checksum only, the way photographs are,
    /// and one that is missing or changed is a note rather than a
    /// problem: the layer comes back pointing at it. Absent in a bundle
    /// written before the choice, which carried them.
    #[serde(default = "kept_by_default")]
    pub finish_pictures_kept: bool,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub path: String,
    pub complete: bool,
    pub images: usize,
    pub graphs: usize,
    pub takes: usize,
    pub presets: usize,
    pub assets: usize,
    pub required_inputs: usize,
    pub app_version: String,
    pub problems: Vec<String>,
    /// What the user should know that does not make the bundle
    /// incomplete: Finish pictures left out by the preference, and any
    /// of those that are missing.
    pub notes: Vec<String>,
    /// Every original the edits refer to that is not at its recorded
    /// path, in full; `problems` carries one line that counts them and
    /// names the first few, so a catalog with hundreds of photographs
    /// on an unplugged drive reads as that and not as a wall of errors.
    pub missing_originals: Vec<String>,
}
/// How many missing originals the problem line names before "and N more".
const MISSING_NAMED: usize = 3;
/// Splits asset failures into missing originals (nothing at the recorded
/// path) and every other failure, which stays its own line. The missing
/// ones become one line: the count, the drives that are not mounted,
/// the first few paths, and what that means for the bundle.
fn asset_problems(failures: Vec<(String, String)>) -> (Vec<String>, Vec<String>) {
    let (mut problems, mut missing) = (Vec::new(), Vec::new());
    for (path, error) in failures {
        if fs::symlink_metadata(&path).is_err() {
            missing.push(path);
        } else {
            problems.push(error);
        }
    }
    if !missing.is_empty() {
        // The same drive rule as Forget Missing Trashed Photos: a macOS
        // volume or a Windows drive or share, named as the paths spell it.
        let mut check = crate::trash::VolumeCheck::default();
        let mut unmounted = BTreeSet::new();
        for path in &missing {
            if let Some(root) = check.unmounted(Path::new(path)) {
                unmounted.insert(root.to_string_lossy().into_owned());
            }
        }
        let n = missing.len();
        let drives = if unmounted.is_empty() {
            String::new()
        } else {
            let list = unmounted.into_iter().collect::<Vec<_>>().join(", ");
            format!(" (not mounted: {list})")
        };
        let first = missing.iter().take(MISSING_NAMED).cloned().collect::<Vec<_>>().join(", ");
        let more = if n > MISSING_NAMED { format!(", and {} more", n - MISSING_NAMED) } else { String::new() };
        problems.insert(
            0,
            format!(
                "{n} original file{} missing{drives}: {first}{more}. The edits are in the bundle; it restores once {} back at {} recorded path{}",
                if n == 1 { " is" } else { "s are" },
                if n == 1 { "that file is" } else { "they are" },
                if n == 1 { "its" } else { "their" },
                if n == 1 { "" } else { "s" },
            ),
        );
    }
    (problems, missing)
}
fn named(path: &Path, e: impl std::fmt::Display) -> String {
    format!("{e}: {}", path.display())
}
fn digest(path: &Path) -> Result<(u64, String), String> {
    let mut file = File::open(path).map_err(|e| named(path, e))?;
    let before = file.metadata().map_err(|e| named(path, e))?;
    if !before.is_file() {
        return Err(named(path, "not a regular file"));
    }
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf).map_err(|e| named(path, e))?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        hash.update(&buf[..n]);
    }
    let after = file.metadata().map_err(|e| named(path, e))?;
    if before.len() != bytes
        || after.len() != bytes
        || before.modified().ok() != after.modified().ok()
    {
        return Err(named(
            path,
            "changed while checksumming; try again once it finishes writing",
        ));
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}
fn sync_dir(path: &Path) -> Result<(), String> {
    // A directory cannot be opened for fsync on Windows, so there the
    // rename that publishes a bundle is as durable as it gets. A
    // runtime cfg rather than an attribute: both arms compile on every
    // platform, so no platform sees the path unused.
    if cfg!(unix) {
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|e| named(path, e))?;
    }
    Ok(())
}
fn copy_new(source: &Path, dest: &Path) -> Result<(), String> {
    let mut input = File::open(source).map_err(|e| named(source, e))?;
    fs::create_dir_all(dest.parent().ok_or("no parent folder")?).map_err(|e| named(dest, e))?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dest)
        .map_err(|e| named(dest, e))?;
    std::io::copy(&mut input, &mut output).map_err(|e| named(dest, e))?;
    output.sync_all().map_err(|e| named(dest, e))
}
fn safe_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty()
        || rel.contains('\\')
        || rel.contains(':')
        || !Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(format!("Unsafe bundle path: {rel}"));
    }
    let mut path = root.to_path_buf();
    for part in Path::new(rel).components() {
        path.push(part);
        let meta = fs::symlink_metadata(&path).map_err(|e| named(&path, e))?;
        if meta.file_type().is_symlink() {
            return Err(named(&path, "symbolic links are not bundle files"));
        }
    }
    Ok(path)
}
/// Files and folders the operating system or a file browser drops into any
/// folder it shows: macOS's .DS_Store and ._ AppleDouble twins, a custom folder
/// icon's "Icon\r", Spotlight and Trash bookkeeping, and the Windows file
/// browser's Thumbs.db and desktop.ini. A bundle is a folder a user can open,
/// so these appear in it after it is written (2026-10-01: a bundle in a Desktop
/// folder verified as "Bundle file inventory differs from its contents"); they
/// are neither copied into a bundle nor counted against one.
fn is_os_metadata(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else { return false };
    // Windows names are not case sensitive, and the file browser has written
    // both "desktop.ini" and "Desktop.ini".
    matches!(
        name,
        ".DS_Store" | "Icon\r" | ".Spotlight-V100" | ".Trashes" | ".fseventsd"
            | ".TemporaryItems" | ".DocumentRevisions-V100"
    ) || name.eq_ignore_ascii_case("Thumbs.db")
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.starts_with("._")
}
fn walk(root: &Path, at: &Path, out: &mut Vec<String>) -> Result<(), String> {
    for entry in fs::read_dir(at).map_err(|e| named(at, e))? {
        let entry = entry.map_err(|e| named(at, e))?;
        if is_os_metadata(&entry.file_name()) {
            continue;
        }
        let p = entry.path();
        let kind = entry.file_type().map_err(|e| named(&p, e))?;
        if kind.is_dir() {
            walk(root, &p, out)?;
        } else if kind.is_file() {
            out.push(
                p.strip_prefix(root)
                    .map_err(|e| named(&p, e))?
                    .to_str()
                    .ok_or("non UTF-8 bundle path")?
                    .replace('\\', "/"),
            );
        } else {
            return Err(named(&p, "recovery refuses links and special files"));
        }
    }
    out.sort();
    Ok(())
}
fn add_ref(refs: &mut BTreeMap<String, BTreeSet<String>>, path: String, source: String) {
    if !path.trim().is_empty() {
        refs.entry(path).or_default().insert(source);
    }
}
/// A trashed photograph whose file is no longer in `.trash`: the user
/// emptied the trash outside Heeler (Heeler deletes nothing;
/// 2026-10-01: "If a file in .trash is not found, I think its clear the
/// user removed it"). Its edits are in the bundle; it is a note, never
/// a missing original.
fn trashed_and_gone(path: &str) -> bool {
    in_trash(path) && fs::symlink_metadata(path).is_err()
}
fn in_trash(path: &str) -> bool {
    Path::new(path).parent().and_then(|d| d.file_name()) == Some(std::ffi::OsStr::new(crate::trash::TRASH_DIR))
}
fn trashed_gone_note(gone: &[String]) -> String {
    let folders = gone
        .iter()
        .filter_map(|p| Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let n = gone.len();
    format!(
        "{n} trashed photograph{} no longer in {} .trash folder{} (removed outside Heeler): {}. {} edits are in the bundle",
        if n == 1 { " is" } else { "s are" },
        if n == 1 { "its" } else { "their" },
        if folders.len() == 1 { "" } else { "s" },
        folders.join(", "),
        if n == 1 { "Its" } else { "Their" },
    )
}
/// The folder a stack's or panorama's members are named against: the
/// one it was made in. A trashed recipe sits in the `.trash` beside
/// that folder while its members stay where they are.
fn recipe_home(recipe: &Path) -> &Path {
    let parent = recipe.parent().unwrap_or(Path::new("."));
    if parent.file_name() == Some(std::ffi::OsStr::new(crate::trash::TRASH_DIR)) {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    }
}
/// For each missing original, another inventoried file with the same
/// name that is where its own record says: the likely place a file
/// moved outside Heeler went. Read from the inventory already taken, so
/// it costs no disk walk.
fn same_name_hints(missing: &[String], assets: &[(String, bool)]) -> Vec<String> {
    let mut present: BTreeMap<std::ffi::OsString, Vec<&str>> = BTreeMap::new();
    for (path, ok) in assets {
        if *ok && !in_trash(path) {
            if let Some(name) = Path::new(path).file_name() {
                present.entry(name.to_os_string()).or_default().push(path);
            }
        }
    }
    let mut hints = Vec::new();
    for path in missing {
        let Some(found) = Path::new(path).file_name().and_then(|n| present.get(n)) else { continue };
        let others = found.iter().filter(|o| **o != path.as_str()).copied().collect::<Vec<_>>();
        if others.is_empty() {
            continue;
        }
        hints.push(format!(
            "{path} is missing, and a file with the same name is at {}: if that is this photograph moved outside Heeler, moving it back to {path} brings its edits back to it",
            others.join(" and ")
        ));
    }
    const NAMED: usize = 10;
    if hints.len() > NAMED {
        let more = hints.len() - NAMED;
        hints.truncate(NAMED);
        hints.push(format!("{more} more missing original{} a file with the same name elsewhere in the catalog", if more == 1 { " has" } else { "s have" }));
    }
    hints
}
fn graph_refs(
    v: &serde_json::Value,
    source: &str,
    ids: &BTreeMap<String, String>,
    moved: &BTreeMap<String, String>,
    refs: &mut BTreeMap<String, BTreeSet<String>>,
) {
    if let Some(kind) = v.get("type").and_then(|v| v.as_str()) {
        if kind == "heeler.file" {
            if let Some(path) = v
                .pointer("/textParams/path")
                .or_else(|| v.pointer("/params/path"))
                .and_then(|v| v.as_str())
            {
                add_ref(refs, moved.get(path).cloned().unwrap_or_else(|| path.into()), source.into());
            }
        } else if kind == "heeler.catalog" {
            if let Some(id) = v
                .pointer("/textParams/image")
                .or_else(|| v.pointer("/params/image"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            {
                add_ref(
                    refs,
                    ids.get(id)
                        .cloned()
                        .unwrap_or_else(|| format!("unresolved-catalog:{id}")),
                    source.into(),
                );
            }
        }
    }
    match v {
        serde_json::Value::Object(m) => {
            for child in m.values() {
                graph_refs(child, source, ids, moved, refs);
            }
        }
        serde_json::Value::Array(a) => {
            for child in a {
                graph_refs(child, source, ids, moved, refs);
            }
        }
        _ => {}
    }
}
// These pointers name irreplaceable inputs, even though the current app stores
// them next to rebuildable matte caches. Ordinary depth/matte rasters stay out.
fn required_rasters(v: &serde_json::Value, out: &mut BTreeSet<u64>) -> Result<(), String> {
    let text = |key: &str| {
        v.get("textParams")
            .and_then(|p| p.get(key))
            .or_else(|| v.get("params").and_then(|p| p.get(key)))
            .and_then(|p| p.as_str())
    };
    let kind = v.get("type").and_then(|v| v.as_str());
    // A selection's bake, and a pixel mask's: its own base, or the bake
    // under the frozen selection a saved live layer selection became.
    if matches!(kind, Some("heeler.selection_mask" | "heeler.brush_mask")) {
        let frozen = text("base_selection")
            .filter(|t| !t.is_empty())
            .map(|t| serde_json::from_str::<serde_json::Value>(t).map_err(|e| format!("invalid frozen selection: {e}")))
            .transpose()?;
        let inner = frozen.as_ref().and_then(|f| f.get("matte_id")).and_then(|m| m.as_str());
        for pointer in [text("matte_id"), inner].into_iter().flatten() {
            if let Some(hex) = pointer.strip_prefix("baked:") {
                let version = u64::from_str_radix(hex, 16)
                    .map_err(|_| format!("invalid baked selection pointer: baked:{hex}"))?;
                out.insert(version);
            }
        }
    }
    if v.get("type").and_then(|v| v.as_str()) == Some("heeler.inpaint") {
        if let Some(fill) = text("fill_id").filter(|s| !s.is_empty()) {
            out.insert(heeler_graph::hash::fnv1a64(fill.as_bytes()));
        }
    }
    match v {
        serde_json::Value::Object(m) => {
            for child in m.values() {
                required_rasters(child, out)?;
            }
        }
        serde_json::Value::Array(a) => {
            for child in a {
                required_rasters(child, out)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn raster_references(root: &Path, files: &[Entry]) -> Result<BTreeSet<u64>, String> {
    rasters_named_by(
        root,
        files
            .iter()
            .map(|f| f.path.as_str())
            .filter(|p| p.starts_with("graphs/") || p.starts_with("presets/")),
    )
}
fn rasters_named_by<'a>(root: &Path, paths: impl IntoIterator<Item = &'a str>) -> Result<BTreeSet<u64>, String> {
    let mut out = BTreeSet::new();
    for path in paths {
        let bytes = fs::read(safe_path(root, path)?).map_err(|e| e.to_string())?;
        if let Ok(v) = serde_json::from_slice(&bytes) {
            required_rasters(&v, &mut out).map_err(|e| format!("{path}: {e}"))?;
        }
    }
    Ok(out)
}
/// Every raster the saved edits under app data still point at: the
/// graphs and presets folders read live. The Storage clear asks this
/// before it sweeps, so what a bundle would preserve is what a clear
/// keeps. Folders that do not exist name nothing; a linked folder or
/// an unreadable pointer is an error, and the caller refuses rather
/// than guesses.
pub(crate) fn referenced_rasters(data: &Path) -> Result<BTreeSet<u64>, String> {
    let mut paths = Vec::new();
    for folder in ["graphs", "presets"] {
        let dir = data.join(folder);
        if !dir.exists() {
            continue;
        }
        if fs::symlink_metadata(&dir).map_err(|e| named(&dir, e))?.file_type().is_symlink() {
            return Err(named(&dir, "refusing a linked app-data folder"));
        }
        walk(data, &dir, &mut paths)?;
    }
    rasters_named_by(data, paths.iter().map(String::as_str))
}
fn raster_rel(version: u64) -> String {
    format!("vision/smartmasks/{version:016x}.png")
}

// References come from the copied catalog, every take and nested group, and
// stack/panorama members. TIFF/DNG baked results are ordinary catalog/File assets.
// Finish bakes are retained inputs, even when the vision store is external.
// A restored copy uses a 64-digit source-path digest to avoid collisions
// between stores that happen to contain the same original file name.
fn is_layer_copy(path: &Path) -> bool {
    path.is_absolute()
        && path.parent().and_then(Path::file_name).and_then(|s| s.to_str()) == Some("layercopies")
        && path.extension().and_then(|s| s.to_str()) == Some("tif")
        && path.file_stem().and_then(|s| s.to_str()).is_some_and(|s|
            matches!(s.len(), 16 | 64) && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn remap_layer_copies(v: &mut serde_json::Value, paths: &BTreeMap<String, String>) -> bool {
    let mut changed = false;
    if v.get("type").and_then(|v| v.as_str()) == Some("heeler.file") {
        for params in ["params", "textParams"] {
            if let Some(path) = v.get_mut(params).and_then(|v| v.get_mut("path")) {
                if let Some(next) = path.as_str().and_then(|p| paths.get(p)) {
                    *path = serde_json::Value::String(next.clone());
                    changed = true;
                }
            }
        }
    }
    match v {
        serde_json::Value::Object(m) => {
            for child in m.values_mut() { changed |= remap_layer_copies(child, paths); }
        }
        serde_json::Value::Array(a) => {
            for child in a { changed |= remap_layer_copies(child, paths); }
        }
        _ => {}
    }
    changed
}

fn inventory(
    root: &Path,
    files: &[Entry],
) -> Result<(i64, usize, usize, usize, usize, Vec<Asset>), String> {
    let (schema, rows) = Catalog::recovery_inventory(&safe_path(root, "catalog.sqlite")?)
        .map_err(|e| e.to_string())?;
    // A trashed photograph is inventoried where the trash index says its
    // file is; every other reference to its recorded path (a stack's
    // member, a file layer) follows it there.
    let mut moved = BTreeMap::new();
    let mut ids = BTreeMap::new();
    for (id, path, trashed) in rows {
        // Where the trash index says its file is; found nowhere, where
        // it would be inside `.trash` (trashed_and_gone).
        let at = if trashed {
            let (Ok(at) | Err(at)) = crate::trash::locate_trashed(Path::new(&path), &id);
            at.to_string_lossy().into_owned()
        } else {
            path.clone()
        };
        if at != path {
            moved.insert(path, at.clone());
        }
        ids.insert(id, at);
    }
    let mut refs = BTreeMap::new();
    for (id, path) in &ids {
        add_ref(&mut refs, path.clone(), format!("catalog:{id}"));
    }
    let (mut graphs, mut takes, mut presets) = (0, 0, 0);
    for file in files {
        if file.path.starts_with("graphs/") || file.path.starts_with("presets/") {
            // Recovery companions are retained byte for byte but are not current takes.
            let current_graph = file.path.starts_with("graphs/") && file.path.ends_with(".json");
            let preset = file.path.starts_with("presets/")
                && file.path.ends_with(".heelerpreset")
                && !file.path.contains("/.trash/");
            let raw = fs::read(safe_path(root, &file.path)?).map_err(|e| e.to_string())?;
            match serde_json::from_slice::<serde_json::Value>(&raw) {
                Ok(v) => {
                    graph_refs(&v, &file.path, &ids, &moved, &mut refs);
                    if current_graph && v.get("heelerReset").and_then(|v| v.as_bool()) != Some(true)
                    {
                        if !v.get("nodes").is_some_and(|n| n.is_array())
                            || !v.get("wires").is_some_and(|n| n.is_array())
                        {
                            return Err(format!("{}: invalid graph", file.path));
                        }
                        graphs += 1;
                        takes += v
                            .get("versions")
                            .and_then(|v| v.as_array())
                            .map(|a| a.len().max(1))
                            .unwrap_or(1);
                    }
                    if preset {
                        presets += 1;
                    }
                }
                Err(e) if current_graph || preset => return Err(format!("{}: {e}", file.path)),
                Err(_) => {}
            }
        }
    }
    let mut expanded = BTreeSet::new();
    loop {
        let next = refs.keys().find(|p| !expanded.contains(*p)).cloned();
        let Some(path) = next else { break };
        expanded.insert(path.clone());
        let p = Path::new(&path);
        if matches!(
            p.extension().and_then(|e| e.to_str()),
            Some("stack" | "pano")
        ) {
            // Unreadable recipes are captured below as missing assets. Malformed
            // recipes must not quietly lose their member references.
            if let Ok(raw) = fs::read(p) {
                let recipe: serde_json::Value =
                    serde_json::from_slice(&raw).map_err(|e| named(p, e))?;
                let members = recipe
                    .get("members")
                    .and_then(|v| v.as_array())
                    .ok_or_else(|| named(p, "recipe has no members"))?;
                for member in members {
                    let member = member
                        .as_str()
                        .ok_or_else(|| named(p, "invalid member path"))?;
                    // Members are named against the folder the recipe
                    // was made in, which a trashed recipe has left.
                    let member = recipe_home(p).join(member).to_string_lossy().into_owned();
                    add_ref(
                        &mut refs,
                        moved.get(&member).cloned().unwrap_or(member),
                        format!("recipe:{path}"),
                    );
                }
            }
        }
    }
    // The checksums are the inventory's whole cost on a real catalog
    // (every original read end to end), and each is independent of the
    // next: they run in parallel. collect() on a Vec's parallel iterator
    // keeps the manifest's order.
    use rayon::prelude::*;
    let assets: Vec<Asset> = refs
        .into_iter()
        .collect::<Vec<_>>()
        .into_par_iter()
        .map(|(path, references)| {
            let retained = files.iter().find(|f| f.path.starts_with("vision/layercopies/") && f.source == path);
            let result = if let Some(file) = retained {
                safe_path(root, &file.path).and_then(|p| digest(&p))
            } else if Path::new(&path).is_absolute() {
                digest(Path::new(&path))
            } else {
                Err(format!(
                    "{path}: source path is not absolute or cannot be resolved"
                ))
            };
            let (bytes, sha256, error) = match result {
                Ok((n, h)) => (Some(n), Some(h), None),
                Err(e) => (None, None, Some(e)),
            };
            Asset {
                path,
                references: references.into_iter().collect(),
                bytes,
                sha256,
                error,
            }
        })
        .collect();
    Ok((schema, ids.len(), graphs, takes, presets, assets))
}

pub fn create(
    catalog: &Catalog,
    catalog_path: &Path,
    data: &Path,
    dest: &Path,
) -> Result<Report, String> {
    create_with(catalog, catalog_path, data, dest, |_| Ok(()))
}
fn create_with(
    catalog: &Catalog,
    catalog_path: &Path,
    data: &Path,
    dest: &Path,
    checkpoint: impl Fn(usize) -> Result<(), String>,
) -> Result<Report, String> {
    if fs::symlink_metadata(dest).is_ok() {
        return Err(named(dest, "already exists; choose a new bundle name"));
    }
    let parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent = fs::canonicalize(parent).map_err(|e| named(parent, e))?;
    let data = fs::canonicalize(data).map_err(|e| named(data, e))?;
    if parent.starts_with(&data) {
        return Err("Choose a recovery destination outside app data".into());
    }
    let stage = heeler_project::atomic::unique_neighbor(dest, "partial");
    fs::create_dir(&stage).map_err(|e| named(&stage, e))?;
    let result = (|| {
        catalog
            .backup_to(&stage.join("catalog.sqlite"), false)
            .map_err(|e| e.to_string())?;
        let snapshot = stage.join("catalog.sqlite");
        heeler_project::atomic::sync_file(&snapshot).map_err(|e| named(&snapshot, e))?;
        let mut copied = vec![Entry {
            path: "catalog.sqlite".into(),
            bytes: 0,
            sha256: String::new(),
            source: catalog_path.to_string_lossy().into_owned(),
        }];
        checkpoint(copied.len())?;
        crate::graphstore::snapshot(|| {
            for folder in ["graphs", "presets"] {
                let dir = data.join(folder);
                if !dir.exists() {
                    continue;
                }
                if fs::symlink_metadata(&dir)
                    .map_err(|e| named(&dir, e))?
                    .file_type()
                    .is_symlink()
                {
                    return Err(named(&dir, "recovery refuses linked app-data folders"));
                }
                let mut paths = Vec::new();
                walk(&data, &dir, &mut paths)?;
                for path in paths {
                    let source = safe_path(&data, &path)?;
                    copy_new(&source, &stage.join(&path))?;
                    copied.push(Entry {
                        path,
                        bytes: 0,
                        sha256: String::new(),
                        source: source.to_string_lossy().into_owned(),
                    });
                    checkpoint(copied.len())?;
                }
            }
            Ok(())
        })?;
        let vision = crate::vision_base_offline(data.join("vision"), Some(catalog));
        for version in raster_references(&stage, &copied)? {
            let source = crate::smart_raster_lookup(&vision, version);
            let path = raster_rel(version);
            copy_new(&source, &stage.join(&path))?;
            copied.push(Entry {
                path,
                bytes: 0,
                sha256: String::new(),
                source: source.to_string_lossy().into_owned(),
            });
            checkpoint(copied.len())?;
            // A converted selection solved at full resolution at Apply
            // keeps that answer beside its base (fullmatte.rs): it goes
            // with it, or a restored catalog would export soft hair.
            let twin = crate::fullmatte::full_matte_path(&vision, version);
            if twin.is_file() {
                let path = raster_rel(crate::fullmatte::full_matte_version(version));
                copy_new(&twin, &stage.join(&path))?;
                copied.push(Entry {
                    path,
                    bytes: 0,
                    sha256: String::new(),
                    source: twin.to_string_lossy().into_owned(),
                });
                checkpoint(copied.len())?;
            }
        }
        // Read all saved seats, including takes, nested groups and presets.
        // Only retained Finish files join the bundle; ordinary photographs
        // remain external assets and are never written.
        let (catalog_schema, images, graphs, takes, presets, mut assets) = inventory(&stage, &copied)?;
        let keep_finish = keeps_finish_pictures(catalog);
        for asset in assets.iter().filter(|a| keep_finish && is_layer_copy(Path::new(&a.path))) {
            let source = Path::new(&asset.path);
            if fs::symlink_metadata(source).map_err(|e| named(source, e))?.file_type().is_symlink() {
                return Err(named(source, "recovery refuses linked Finish inputs"));
            }
            let path = format!("vision/layercopies/{:x}.tif", Sha256::digest(asset.path.as_bytes()));
            copy_new(source, &stage.join(&path))?;
            copied.push(Entry { path, bytes: 0, sha256: String::new(), source: asset.path.clone() });
            checkpoint(copied.len())?;
        }
        // The staged copies' checksums, in parallel: each is its own
        // file, and the first error in bundle order still fails the
        // create.
        {
            use rayon::prelude::*;
            let digests: Vec<Result<(u64, String), String>> =
                copied.par_iter().map(|entry| digest(&stage.join(&entry.path))).collect();
            for (entry, digested) in copied.iter_mut().zip(digests) {
                (entry.bytes, entry.sha256) = digested?;
            }
        }
        // Keep the inventory's external-source checksums; hashing every
        // original again would double recovery's photograph I/O.
        for asset in &mut assets {
            if let Some(file) = copied.iter().find(|f| f.path.starts_with("vision/layercopies/") && f.source == asset.path) {
                asset.bytes = Some(file.bytes);
                asset.sha256 = Some(file.sha256.clone());
                asset.error = None;
            }
        }
        let manifest = Manifest {
            schema: SCHEMA,
            catalog_schema,
            app_version: env!("CARGO_PKG_VERSION").into(),
            source_catalog: catalog_path.to_string_lossy().into_owned(),
            source_app_data: crate::plain_path(data.clone()).to_string_lossy().into_owned(),
            files: copied,
            assets,
            optional_caches_omitted: OPTIONAL.iter().map(|s| (*s).into()).collect(),
            images,
            graphs,
            takes,
            presets,
            finish_pictures_kept: keep_finish,
        };
        // Left out by the preference, a Finish picture that is missing is
        // a note: the user chose not to carry it, and the rest of the
        // bundle is whole.
        let (mut failures, mut notes, mut gone) = (Vec::new(), Vec::new(), Vec::new());
        for a in &manifest.assets {
            match &a.error {
                Some(_) if !keep_finish && is_layer_copy(Path::new(&a.path)) => notes.push(missing_note(&a.path)),
                Some(_) if trashed_and_gone(&a.path) => gone.push(a.path.clone()),
                Some(e) => failures.push((a.path.clone(), e.clone())),
                None => {}
            }
        }
        if !gone.is_empty() {
            notes.push(trashed_gone_note(&gone));
        }
        let (problems, missing) = asset_problems(failures);
        let present = manifest.assets.iter().map(|a| (a.path.clone(), a.error.is_none())).collect::<Vec<_>>();
        notes.extend(same_name_hints(&missing, &present));
        if !keep_finish {
            let left = manifest.assets.iter().filter(|a| is_layer_copy(Path::new(&a.path))).count();
            if left > 0 {
                notes.insert(0, left_out_note(left));
            }
        }
        let raw = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.join("manifest.json"))
            .map_err(|e| e.to_string())?;
        file.write_all(&raw)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        // Closed before the rename: Windows refuses to rename a folder
        // while any file inside it is open.
        drop(file);
        sync_tree(&stage)?;
        if fs::symlink_metadata(dest).is_ok() {
            return Err(named(dest, "already exists"));
        }
        fs::rename(&stage, dest).map_err(|e| named(dest, e))?;
        sync_dir(&parent)?;
        Ok(report(dest, &manifest, problems, notes, missing))
    })();
    // A failed bundle leaves its staging folder where it is: it sits in a
    // folder the user chose, and nothing in this app deletes there. The
    // error names it, the verifier refuses it, and removing it is the
    // user's call, the same as the trash.
    result.map_err(|e| format!("{e}. The unfinished staging folder is left at {}", stage.display()))
}
fn sync_tree(at: &Path) -> Result<(), String> {
    for entry in fs::read_dir(at).map_err(|e| named(at, e))? {
        let entry = entry.map_err(|e| named(at, e))?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            sync_tree(&entry.path())?;
        }
    }
    sync_dir(at)
}
fn report(path: &Path, m: &Manifest, problems: Vec<String>, notes: Vec<String>, missing_originals: Vec<String>) -> Report {
    Report {
        path: path.to_string_lossy().into_owned(),
        complete: problems.is_empty(),
        images: m.images,
        graphs: m.graphs,
        takes: m.takes,
        presets: m.presets,
        assets: m.assets.len(),
        required_inputs: m
            .files
            .iter()
            .filter(|f| f.path.starts_with("vision/smartmasks/") || f.path.starts_with("vision/layercopies/"))
            .count(),
        app_version: m.app_version.clone(),
        problems,
        notes,
        missing_originals,
    }
}
pub fn verify(root: &Path) -> Result<Report, String> {
    inspect(root).map(|(m, problems, notes, missing)| report(root, &m, problems, notes, missing))
}
type Inspected = (Manifest, Vec<String>, Vec<String>, Vec<String>);
fn inspect(root: &Path) -> Result<Inspected, String> {
    if root.extension().and_then(|s| s.to_str()) == Some("partial") {
        return Err("Unfinished recovery staging directory".into());
    }
    if fs::symlink_metadata(root)
        .map_err(|e| named(root, e))?
        .file_type()
        .is_symlink()
    {
        return Err("Choose the bundle itself, not a symbolic link".into());
    }
    let raw = fs::read(safe_path(root, "manifest.json")?).map_err(|e| named(root, e))?;
    let m: Manifest = serde_json::from_slice(&raw).map_err(|e| named(root, e))?;
    if m.schema != SCHEMA {
        return Err(format!("Unsupported recovery schema {}", m.schema));
    }
    let mut problems = Vec::new();
    let mut notes = Vec::new();
    let mut expected = BTreeSet::from(["manifest.json".to_string()]);
    let mut to_digest: Vec<&Entry> = Vec::new();
    for file in &m.files {
        if !(file.path == "catalog.sqlite"
            || file.path.starts_with("graphs/")
            || file.path.starts_with("presets/")
            || file.path.starts_with("vision/smartmasks/")
            || file.path.starts_with("vision/layercopies/"))
            || !expected.insert(file.path.clone())
        {
            return Err(format!(
                "Unexpected or duplicate bundle file: {}",
                file.path
            ));
        }
        if fs::symlink_metadata(root.join(&file.path)).is_err() {
            problems.push(format!("{}: listed in the manifest but not in the bundle", file.path));
            continue;
        }
        to_digest.push(file);
    }
    // The checksums are verify's whole cost on a real bundle and each
    // is its own file: they run in parallel, their problems listed in
    // the manifest's order.
    {
        use rayon::prelude::*;
        let checked: Vec<Option<String>> = to_digest
            .par_iter()
            .map(|file| match safe_path(root, &file.path).and_then(|p| digest(&p)) {
                Ok((n, h)) if n == file.bytes && h == file.sha256 => None,
                Ok(_) => Some(format!("{}: checksum or size differs", file.path)),
                Err(e) => Some(e),
            })
            .collect();
        problems.extend(checked.into_iter().flatten());
    }
    if !expected.contains("catalog.sqlite") {
        return Err("Bundle has no catalog snapshot".into());
    }
    // Every listed file is whole, so the edits and the sources can be
    // read. A file the manifest does not list is said by name, and it
    // does not stop the checks below: the user still learns what is
    // missing outside the bundle. Operating-system files (is_os_metadata)
    // are not counted at all; walk skips them.
    let intact = problems.is_empty();
    let mut actual = Vec::new();
    walk(root, root, &mut actual)?;
    let extra = actual.into_iter().filter(|p| !expected.contains(p)).collect::<Vec<_>>();
    if !extra.is_empty() {
        let first = extra.iter().take(MISSING_NAMED).cloned().collect::<Vec<_>>().join(", ");
        let more = if extra.len() > MISSING_NAMED { format!(", and {} more", extra.len() - MISSING_NAMED) } else { String::new() };
        problems.push(format!(
            "The bundle holds {} file{} its manifest does not list: {first}{more}. Something wrote into the bundle after it was made; move those out of it and verify again",
            extra.len(),
            if extra.len() == 1 { "" } else { "s" },
        ));
    }
    let (mut failures, mut gone, mut on_disk) = (Vec::new(), Vec::new(), Vec::new());
    if intact {
        let versions = raster_references(root, &m.files)?;
        let required = versions.iter().copied().map(raster_rel).collect::<BTreeSet<_>>();
        // A base's full-resolution twin may ride beside it, never alone.
        let twins = versions
            .iter()
            .map(|v| raster_rel(crate::fullmatte::full_matte_version(*v)))
            .collect::<BTreeSet<_>>();
        let present = m
            .files
            .iter()
            .filter(|f| f.path.starts_with("vision/smartmasks/"))
            .map(|f| f.path.clone())
            .collect::<BTreeSet<_>>();
        if !required.is_subset(&present) || present.iter().any(|p| !required.contains(p) && !twins.contains(p)) {
            problems.push(
                "Required baked selection or inpaint inputs differ from their saved references"
                    .into(),
            );
        }
        match inventory(root, &m.files) {
            Ok((schema, images, graphs, takes, presets, assets)) => {
                if (schema, images, graphs, takes, presets)
                    != (m.catalog_schema, m.images, m.graphs, m.takes, m.presets)
                {
                    problems.push("Catalog schema or edit counts differ from the manifest".into());
                }
                let by_path: BTreeMap<_, _> =
                    m.assets.iter().map(|a| (a.path.as_str(), a)).collect();
                if by_path.len() != m.assets.len() || assets.len() != m.assets.len() {
                    problems.push("Source inventory differs from the saved references".into());
                }
                on_disk = assets.iter().map(|a| (a.path.clone(), a.error.is_none())).collect();
                let left_out = !m.finish_pictures_kept;
                if left_out {
                    let left = assets.iter().filter(|a| is_layer_copy(Path::new(&a.path))).count();
                    if left > 0 {
                        notes.push(left_out_note(left));
                    }
                }
                for asset in assets {
                    let finish = is_layer_copy(Path::new(&asset.path));
                    if finish && !left_out && !m.files.iter().any(|f|
                        f.path.starts_with("vision/layercopies/") && f.source == asset.path) {
                        problems.push(format!("{}: required Finish input is not retained in the bundle", asset.path));
                    }
                    // A photograph put back from the trash, or trashed,
                    // since the bundle was made is the same file at its
                    // other address: matched by what refers to it and
                    // its checksum.
                    let saved = by_path.get(asset.path.as_str()).copied().or_else(|| {
                        m.assets.iter().find(|s| {
                            s.references == asset.references
                                && s.sha256.is_some()
                                && s.sha256 == asset.sha256
                                && s.bytes == asset.bytes
                        })
                    });
                    match saved {
                        Some(saved)
                            if saved.references == asset.references
                                && saved.sha256 == asset.sha256
                                && saved.bytes == asset.bytes
                                && saved.error.is_none()
                                && asset.error.is_none() => {}
                        // Trashed, then emptied from .trash outside Heeler.
                        Some(saved)
                            if saved.references == asset.references
                                && asset.error.is_some()
                                && trashed_and_gone(&asset.path) => gone.push(asset.path.clone()),
                        // Left out by the preference: missing or changed
                        // is said, and the bundle restores without it.
                        Some(saved) if finish && left_out && saved.references == asset.references => notes.push(if asset.error.is_some() {
                            missing_note(&asset.path)
                        } else {
                            format!("{}: this Layer via Copy or Bake Warp picture changed since the bundle was made", asset.path)
                        }),
                        _ => {
                            let error = asset.error.unwrap_or_else(|| {
                                format!(
                                    "{}: missing inventory, changed source or incomplete capture",
                                    asset.path
                                )
                            });
                            failures.push((asset.path, error));
                        }
                    }
                }
            }
            Err(e) => problems.push(e),
        }
    }
    if !gone.is_empty() {
        notes.push(trashed_gone_note(&gone));
    }
    let (sources, missing) = asset_problems(failures);
    problems.extend(sources);
    notes.extend(same_name_hints(&missing, &on_disk));
    Ok((m, problems, notes, missing))
}
/// Offline restore accepts only an empty app-data directory. Originals are
/// verified first and never written. Every destination file uses create_new.
pub fn restore(root: &Path, dest: &Path) -> Result<Report, String> {
    let (m, problems, notes, _) = inspect(root)?;
    if !problems.is_empty() {
        return Err(format!("Recovery is incomplete: {}", problems.join("; ")));
    }
    if fs::symlink_metadata(dest)
        .map_err(|e| named(dest, e))?
        .file_type()
        .is_symlink()
        || fs::read_dir(dest)
            .map_err(|e| named(dest, e))?
            .next()
            .is_some()
    {
        return Err("Restore requires an empty app-data directory".into());
    }
    for file in &m.files {
        copy_new(&safe_path(root, &file.path)?, &dest.join(&file.path))?;
        if digest(&dest.join(&file.path))? != (file.bytes, file.sha256.clone()) {
            return Err(format!("{} changed while restoring", file.path));
        }
    }
    if m.files
        .iter()
        .any(|f| f.path.starts_with("vision/smartmasks/"))
    {
        // Every raster in a bundle is one a saved edit points at, so it
        // goes straight under the retained roof, where the Storage clear
        // never looks. The bundle keeps the older path so a bundle
        // written before the split restores the same way.
        let kept = dest.join("vision/smartinputs");
        fs::create_dir_all(&kept).map_err(|e| named(&kept, e))?;
        for file in m.files.iter().filter(|f| f.path.starts_with("vision/smartmasks/")) {
            let from = dest.join(&file.path);
            let name = from.file_name().ok_or_else(|| format!("{} has no file name", file.path))?;
            fs::rename(&from, kept.join(name)).map_err(|e| named(&from, e))?;
        }
        // Restored required inputs live inside the new app data, never in an old
        // external model folder. The source catalog and originals stay untouched.
        let catalog = Catalog::open(&dest.join("catalog.sqlite")).map_err(|e| e.to_string())?;
        if let Some(raw) = catalog.meta("ui_settings").map_err(|e| e.to_string())? {
            let mut settings: serde_json::Value =
                serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            if let Some(prefs) = settings.get_mut("prefs").and_then(|v| v.as_object_mut()) {
                prefs.insert("modelStoreDir".into(), serde_json::json!(""));
                catalog
                    .set_meta("ui_settings", &settings.to_string())
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    // The restored layer copies' new paths go into the graphs and the
    // catalog: in their usual form, never Windows' `\\?\C:\...`.
    let dest = crate::plain_path(fs::canonicalize(dest).map_err(|e| named(dest, e))?);
    let paths: BTreeMap<String, String> = m.files.iter()
        .filter(|f| f.path.starts_with("vision/layercopies/"))
        .map(|f| (f.source.clone(), dest.join(&f.path).to_string_lossy().into_owned()))
        .collect();
    if !paths.is_empty() {
        for file in m.files.iter().filter(|f| f.path.starts_with("graphs/") || f.path.starts_with("presets/")) {
            let path = dest.join(&file.path);
            let raw = fs::read(&path).map_err(|e| named(&path, e))?;
            if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&raw) {
                if remap_layer_copies(&mut value, &paths) {
                    fs::write(&path, serde_json::to_vec(&value).map_err(|e| named(&path, e))?)
                        .map_err(|e| named(&path, e))?;
                }
            }
        }
        let (_, rows) = Catalog::recovery_inventory(&dest.join("catalog.sqlite")).map_err(|e| e.to_string())?;
        let catalog = Catalog::open(&dest.join("catalog.sqlite")).map_err(|e| e.to_string())?;
        for (id, old, _) in rows {
            if let Some(next) = paths.get(&old) {
                let next = Path::new(next);
                let folder = catalog.add_folder(next.parent().ok_or("Finish input has no folder")?).map_err(|e| e.to_string())?;
                catalog.set_image_path(&id, next, Some(folder)).map_err(|e| e.to_string())?;
            }
        }
    }
    sync_tree(&dest)?;
    Ok(report(&dest, &m, Vec::new(), notes, Vec::new()))
}

pub fn cli(args: &[String]) -> i32 {
    let result = match args {
        [command, bundle] if command == "verify" => verify(Path::new(bundle)),
        [command, bundle, dest] if command == "restore" => {
            restore(Path::new(bundle), Path::new(dest))
        }
        _ => {
            eprintln!("Usage: heeler-desktop recovery verify BUNDLE | recovery restore BUNDLE EMPTY_APP_DATA");
            return 2;
        }
    };
    match result {
        Ok(report) => {
            println!("{}", serde_json::to_string_pretty(&report).unwrap());
            if report.complete {
                0
            } else {
                1
            }
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    struct Fixture {
        temp: tempfile::TempDir,
        data: PathBuf,
        original: PathBuf,
        catalog: Catalog,
        bundle: PathBuf,
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        fs::create_dir_all(data.join("graphs")).unwrap();
        fs::create_dir_all(data.join("presets/Personal")).unwrap();
        let original = temp.path().join("photo.png");
        let mut pixels = heeler_engine::ImageBuf::filled(6, 4, [0.2, 0.3, 0.4, 1.0]);
        pixels.set_pixel(2, 1, [0.7, 0.1, 0.5, 1.0]);
        fs::write(&original, heeler_io::encode_png16(&pixels).unwrap()).unwrap();
        let catalog = Catalog::open(&data.join("catalog.sqlite")).unwrap();
        catalog.add_image("photo", &original, None).unwrap();
        catalog
            .set_meta("export_presets", "[{\"name\":\"Print\"}]")
            .unwrap();
        let render = |exposure: f64| {
            json!({"graph_id":"recovery-test", "nodes":[
            {"id":"src","type":"heeler.image_source","enabled":true,"params":{}},
            {"id":"e","type":"heeler.exposure","enabled":true,"params":{"exposure":exposure}},
            {"id":"out","type":"heeler.output","enabled":true,"params":{}}
        ], "connections":[{"from":["src","out"],"to":["e","in"]},{"from":["e","out"],"to":["out","in"]}]})
        };
        let a = render(0.4);
        let b = render(-0.7);
        let saved = json!({"nodes":a["nodes"],"wires":[],"render":a,"activeVersion":"take_2","versions":[
            {"id":"take_1","name":"Bright","nodes":a["nodes"],"wires":[],"render":a},
            {"id":"take_2","name":"Dark","nodes":b["nodes"],"wires":[],"render":b}
        ]});
        fs::write(
            data.join("graphs/photo.json"),
            serde_json::to_vec(&saved).unwrap(),
        )
        .unwrap();
        fs::write(
            data.join("presets/Personal/Print.heelerpreset"),
            br#"{"schema":1,"nodes":[],"wires":[]}"#,
        )
        .unwrap();
        for cache in ["proxies", "previews", "thumbnails", "depth", "matte"] {
            fs::create_dir(data.join(cache)).unwrap();
            fs::write(data.join(cache).join("cache.bin"), b"rebuildable").unwrap();
        }
        let bundle = temp.path().join("edits.heeler-recovery");
        Fixture {
            temp,
            data,
            original,
            catalog,
            bundle,
        }
    }
    fn make(f: &Fixture) -> Report {
        create(
            &f.catalog,
            &f.data.join("catalog.sqlite"),
            &f.data,
            &f.bundle,
        )
        .unwrap()
    }
    fn pixels(data: &Path, original: &Path) -> Vec<Vec<u8>> {
        let saved: serde_json::Value =
            serde_json::from_slice(&fs::read(data.join("graphs/photo.json")).unwrap()).unwrap();
        saved["versions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|take| {
                let graph = serde_json::from_value(take["render"].clone()).unwrap();
                let image = heeler_io::decode_any(original).unwrap();
                let rendered =
                    crate::render_export(&graph, Arc::new(image), &Default::default()).unwrap();
                heeler_io::encode_png16(&rendered).unwrap()
            })
            .collect()
    }
    #[test]
    fn restore_empty_app_data_preserves_takes_graphs_presets_and_exported_pixels() {
        let f = fixture();
        let original = fs::read(&f.original).unwrap();
        let before = pixels(&f.data, &f.original);
        assert_ne!(
            before[0], before[1],
            "both takes must exercise real processing"
        );
        let made = make(&f);
        assert!(made.complete, "{:?}", made.problems);
        assert_eq!(
            (made.images, made.graphs, made.takes, made.presets),
            (1, 1, 2, 1)
        );
        let bundle_before = digest(&f.bundle.join("catalog.sqlite")).unwrap();
        assert!(verify(&f.bundle).unwrap().complete);
        assert_eq!(
            bundle_before,
            digest(&f.bundle.join("catalog.sqlite")).unwrap()
        );
        let restored = f.temp.path().join("restored");
        fs::create_dir(&restored).unwrap();
        let r = restore(&f.bundle, &restored).unwrap();
        assert_eq!(r.takes, made.takes);
        assert_eq!(
            crate::active_catalog_in(&restored),
            restored.join("catalog.sqlite")
        );
        assert_eq!(
            fs::read(f.data.join("graphs/photo.json")).unwrap(),
            fs::read(restored.join("graphs/photo.json")).unwrap()
        );
        assert_eq!(
            fs::read(f.data.join("presets/Personal/Print.heelerpreset")).unwrap(),
            fs::read(restored.join("presets/Personal/Print.heelerpreset")).unwrap()
        );
        assert_eq!(
            Catalog::open(&restored.join("catalog.sqlite"))
                .unwrap()
                .meta("export_presets")
                .unwrap(),
            Some("[{\"name\":\"Print\"}]".into())
        );
        assert_eq!(before, pixels(&restored, &f.original));
        assert_eq!(original, fs::read(&f.original).unwrap());
        for cache in ["proxies", "previews", "thumbnails", "depth", "matte"] {
            assert!(!restored.join(cache).exists());
        }
    }
    #[test]
    fn interrupted_write_never_publishes_a_bundle_or_changes_originals() {
        let f = fixture();
        let before = digest(&f.original).unwrap();
        let err = create_with(
            &f.catalog,
            &f.data.join("catalog.sqlite"),
            &f.data,
            &f.bundle,
            |n| {
                if n == 2 {
                    Err("injected full disk".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert!(err.contains("full disk"));
        assert!(!f.bundle.exists());
        assert_eq!(before, digest(&f.original).unwrap());
        // The staging folder stays, named in the error, and is refused as
        // a bundle: nothing here deletes inside a folder the user chose.
        let partial = fs::read_dir(f.temp.path())
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| p.extension().and_then(|e| e.to_str()) == Some("partial"))
            .expect("the staging folder is left for the user");
        assert!(err.contains(&partial.display().to_string()));
        assert!(verify(&partial).unwrap_err().contains("Unfinished"));
    }
    #[test]
    fn verifier_reports_changed_missing_sources_and_damaged_bundle_files() {
        let f = fixture();
        make(&f);
        fs::write(&f.original, b"changed").unwrap();
        let changed = verify(&f.bundle).unwrap();
        assert!(!changed.complete);
        assert!(changed.problems.iter().any(|p| p.contains("photo.png")));
        fs::remove_file(&f.original).unwrap();
        assert!(!verify(&f.bundle).unwrap().complete);
        fs::write(f.bundle.join("graphs/photo.json"), b"damaged").unwrap();
        assert!(verify(&f.bundle)
            .unwrap()
            .problems
            .iter()
            .any(|p| p.contains("checksum")));
        let restored = f.temp.path().join("empty");
        fs::create_dir(&restored).unwrap();
        assert!(restore(&f.bundle, &restored).is_err());
        assert_eq!(fs::read_dir(restored).unwrap().count(), 0);
    }
    #[test]
    fn inventories_hidden_trashed_nested_file_catalog_and_recipe_members() {
        let f = fixture();
        f.catalog.set_hidden("photo", true).unwrap();
        let baked = f.temp.path().join("baked-stack.tiff");
        fs::write(&baked, b"non-rebuildable baked result").unwrap();
        let extra = f.temp.path().join("extra.png");
        fs::write(&extra, b"file layer").unwrap();
        let recipe = f.temp.path().join("trip.pano");
        fs::write(&recipe, br#"{"members":["photo.png","trip.stack"]}"#).unwrap();
        fs::write(f.temp.path().join("trip.stack"), br#"{"members":["baked-stack.tiff"]}"#).unwrap();
        f.catalog.add_image("pano", &recipe, None).unwrap();
        let trash = f.temp.path().join(".trash");
        fs::create_dir(&trash).unwrap();
        fs::write(trash.join("gone.png"), b"trashed original").unwrap();
        f.catalog
            .add_image("gone", &f.temp.path().join("gone.png"), None)
            .unwrap();
        f.catalog.set_trashed("gone", true).unwrap();
        let p = f.data.join("graphs/photo.json");
        let mut g: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        g["versions"][1]["group"] = json!({"nodes":[{"type":"heeler.file","textParams":{"path":extra}},{"type":"heeler.catalog","textParams":{"image":"pano"}}]});
        fs::write(&p, serde_json::to_vec(&g).unwrap()).unwrap();
        assert!(make(&f).complete);
        let (m, problems, _, _) = inspect(&f.bundle).unwrap();
        assert!(problems.is_empty());
        assert!(m.assets.iter().any(|a| a.path == baked.to_str().unwrap()
            && a.references.iter().any(|r| r.starts_with("recipe:"))));
        assert!(m.assets.iter().any(|a| a.path == extra.to_str().unwrap()));
        assert!(m
            .assets
            .iter()
            .any(|a| a.path == trash.join("gone.png").to_str().unwrap()));
    }
    #[test]
    fn preserves_baked_selection_and_fill_inputs_but_omits_rebuildable_rasters() {
        let f = fixture();
        let custom = f.temp.path().join("external-vision");
        fs::create_dir_all(custom.join("smartmasks")).unwrap();
        f.catalog
            .set_meta(
                "ui_settings",
                &json!({"prefs":{"modelStoreDir":custom}}).to_string(),
            )
            .unwrap();
        let p = f.data.join("graphs/photo.json");
        let mut g: serde_json::Value = serde_json::from_slice(&fs::read(&p).unwrap()).unwrap();
        g["versions"][1]["nodes"].as_array_mut().unwrap().extend([
            json!({"id":"mask","type":"heeler.selection_mask","params":{},"textParams":{"matte_id":"baked:abc"}}),
            json!({"id":"fill","type":"heeler.inpaint","params":{},"textParams":{"fill_id":"chosen-fill"}}),
        ]);
        fs::write(&p, serde_json::to_vec(&g).unwrap()).unwrap();
        let fill = heeler_graph::hash::fnv1a64(b"chosen-fill");
        // The base as a bake before the split left it, in the cache; the
        // fill as the app writes it now, under the retained roof; and a
        // depth plane nothing points at.
        fs::create_dir_all(custom.join("smartinputs")).unwrap();
        for (version, path) in [
            (0xabc, crate::smart_raster_path(&custom, 0xabc)),
            (fill, crate::retained_raster_path(&custom, fill)),
            (99, crate::smart_raster_path(&custom, 99)),
        ] {
            let _ = version;
            fs::write(path, b"required-input-bytes").unwrap();
        }
        // The base's full-resolution twin from an Apply (fullmatte.rs)
        // rides with it; the fill has none.
        let twin = crate::fullmatte::full_matte_version(0xabc);
        fs::write(crate::fullmatte::full_matte_path(&custom, 0xabc), b"full-resolution-twin").unwrap();
        assert_eq!(referenced_rasters(&f.data).unwrap(), BTreeSet::from([0xabc, fill]));
        assert!(make(&f).complete);
        assert!(f.bundle.join(raster_rel(0xabc)).exists());
        assert!(f.bundle.join(raster_rel(fill)).exists());
        assert!(f.bundle.join(raster_rel(twin)).exists(), "the twin travels with its base");
        assert!(!f.bundle.join(raster_rel(99)).exists());
        let restored = f.temp.path().join("restored");
        fs::create_dir(&restored).unwrap();
        restore(&f.bundle, &restored).unwrap();
        let catalog = Catalog::open(&restored.join("catalog.sqlite")).unwrap();
        let vision = crate::vision_base_offline(restored.join("vision"), Some(&catalog));
        for version in [0xabc, fill] {
            let kept = crate::retained_raster_path(&vision, version);
            assert_eq!(fs::read(&kept).unwrap(), b"required-input-bytes");
            assert_eq!(crate::smart_raster_lookup(&vision, version), kept);
            assert!(!crate::smart_raster_path(&vision, version).exists());
        }
        assert_eq!(fs::read(crate::fullmatte::full_matte_path(&vision, 0xabc)).unwrap(), b"full-resolution-twin");
        assert!(f
            .catalog
            .meta("ui_settings")
            .unwrap()
            .unwrap()
            .contains("external-vision"));
        fs::remove_file(f.bundle.join(raster_rel(0xabc))).unwrap();
        assert!(!verify(&f.bundle).unwrap().complete);
    }
    #[test]
    fn malformed_baked_pointers_are_named_and_never_publish_a_complete_capture() {
        for suffix in ["invalid", "", "10000000000000000"] {
            let f = fixture();
            let path = f.data.join("graphs/photo.json");
            let mut graph: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            graph["nodes"].as_array_mut().unwrap().push(json!({"type":"heeler.selection_mask", "textParams":{"matte_id":format!("baked:{suffix}")}}));
            fs::write(&path, serde_json::to_vec(&graph).unwrap()).unwrap();
            let error = create(&f.catalog, &f.data.join("catalog.sqlite"), &f.data, &f.bundle).unwrap_err();
            assert!(error.contains("graphs/photo.json"));
            assert!(error.contains("invalid baked selection pointer"));
            assert!(!f.bundle.exists());
            let stage = fs::read_dir(f.temp.path()).unwrap().filter_map(Result::ok)
                .find(|e| e.file_name().to_string_lossy().ends_with(".partial")).unwrap().path();
            assert_eq!(fs::read(stage.join("graphs/photo.json")).unwrap(), fs::read(&path).unwrap());
        }
        let f = fixture();
        make(&f);
        let path = f.bundle.join("graphs/photo.json");
        let mut graph: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        graph["nodes"].as_array_mut().unwrap().push(json!({"type":"heeler.selection_mask", "textParams":{"matte_id":"baked:invalid"}}));
        fs::write(&path, serde_json::to_vec(&graph).unwrap()).unwrap();
        let manifest = f.bundle.join("manifest.json");
        let mut m: Manifest = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        let entry = m.files.iter_mut().find(|e| e.path == "graphs/photo.json").unwrap();
        (entry.bytes, entry.sha256) = digest(&path).unwrap();
        fs::write(&manifest, serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(verify(&f.bundle).unwrap_err().contains("invalid baked selection pointer"));
    }

    #[test]
    fn missing_asset_is_an_explicit_incomplete_capture_and_cannot_restore() {
        let f = fixture();
        fs::remove_file(&f.original).unwrap();
        let made = make(&f);
        assert!(!made.complete);
        assert!(made.problems[0].contains("photo.png"));
        assert!(!verify(&f.bundle).unwrap().complete);
        let dest = f.temp.path().join("restore");
        fs::create_dir(&dest).unwrap();
        assert!(restore(&f.bundle, &dest).is_err());
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0);
    }
    #[test]
    fn cli_returns_usage_failure_and_success_for_real_bundles() {
        for args in [vec![], vec!["verify"], vec!["unknown", "bundle"], vec!["restore", "bundle"], vec!["verify", "bundle", "extra"]] {
            assert_eq!(cli(&args.into_iter().map(String::from).collect::<Vec<_>>()), 2);
        }
        let f = fixture();
        make(&f);
        let bundle = f.bundle.to_string_lossy().into_owned();
        assert_eq!(cli(&["verify".into(), bundle.clone()]), 0);
        let dest = f.temp.path().join("restored");
        fs::create_dir(&dest).unwrap();
        let args = ["restore".into(), bundle.clone(), dest.to_string_lossy().into_owned()];
        assert_eq!(cli(&args), 0);
        assert!(dest.join("graphs/photo.json").is_file());
        assert_eq!(cli(&args), 1);
        fs::rename(&f.original, f.original.with_extension("retained")).unwrap();
        assert_eq!(cli(&["verify".into(), bundle]), 1);
        assert_eq!(cli(&["verify".into(), f.temp.path().join("missing").to_string_lossy().into_owned()]), 1);
    }

    #[test]
    fn an_older_catalog_snapshot_is_named_old_not_new() {
        let f = fixture();
        make(&f);
        let snapshot = f.bundle.join("catalog.sqlite");
        let mut bytes = fs::read(&snapshot).unwrap();
        // user_version is the signed big-endian i32 at offset 60. Any
        // value under the current schema is older than this build, and
        // the verify report must say so rather than cry "newer".
        bytes[60..64].copy_from_slice(&13i32.to_be_bytes());
        fs::write(&snapshot, &bytes).unwrap();
        let manifest = f.bundle.join("manifest.json");
        let mut m: Manifest = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        let entry = m.files.iter_mut().find(|e| e.path == "catalog.sqlite").unwrap();
        (entry.bytes, entry.sha256) = digest(&snapshot).unwrap();
        fs::write(&manifest, serde_json::to_vec(&m).unwrap()).unwrap();
        let report = verify(&f.bundle).unwrap();
        assert!(!report.complete);
        assert!(
            report.problems.iter().any(|p| p.contains("older than this build")),
            "{:?}",
            report.problems
        );
        assert!(!report.problems.iter().any(|p| p.contains("newer")), "{:?}", report.problems);
    }

    #[test]
    fn refuses_overwrite_nonempty_restore_paths_traversal_and_new_schema() {
        let f = fixture();
        make(&f);
        assert!(create(
            &f.catalog,
            &f.data.join("catalog.sqlite"),
            &f.data,
            &f.bundle
        )
        .is_err());
        assert!(restore(&f.bundle, &f.data).unwrap_err().contains("empty"));
        let manifest = f.bundle.join("manifest.json");
        let mut m: Manifest = serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        m.files[1].path = "graphs/../../photo.png".into();
        fs::write(&manifest, serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(!verify(&f.bundle).unwrap().complete);
        m.schema += 1;
        fs::write(&manifest, serde_json::to_vec(&m).unwrap()).unwrap();
        assert!(verify(&f.bundle).unwrap_err().contains("schema"));
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_in_source_and_bundle() {
        let f = fixture();
        std::os::unix::fs::symlink(f.temp.path().join("absent"), &f.bundle).unwrap();
        assert!(create(
            &f.catalog,
            &f.data.join("catalog.sqlite"),
            &f.data,
            &f.bundle
        )
        .is_err());
        assert!(fs::symlink_metadata(&f.bundle)
            .unwrap()
            .file_type()
            .is_symlink());
        fs::remove_file(&f.bundle).unwrap();
        std::os::unix::fs::symlink(&f.original, f.data.join("graphs/link.json")).unwrap();
        assert!(create(
            &f.catalog,
            &f.data.join("catalog.sqlite"),
            &f.data,
            &f.bundle
        )
        .is_err());
        fs::remove_file(f.data.join("graphs/link.json")).unwrap();
        make(&f);
        fs::remove_file(f.bundle.join("graphs/photo.json")).unwrap();
        std::os::unix::fs::symlink(&f.original, f.bundle.join("graphs/photo.json")).unwrap();
        assert!(verify(&f.bundle).is_err());
    }
    #[test]
    fn finish_layer_copies_survive_loss_of_the_old_store_and_restore_to_new_paths() {
        let f = fixture();
        // Exercise a custom model store too: layer copies live under the vision base.
        let vision = f.temp.path().join("custom-vision");
        let image = heeler_engine::ImageBuf::filled(6, 4, [0.2, 0.4, 0.6, 0.5]);
        let cut = crate::layer_copy::cut_shown(&image).unwrap();
        let copy = crate::layer_copy::keep_copy(&vision, 42, &cut).unwrap();
        let bytes = fs::read(&copy.path).unwrap();
        let graph_path = f.data.join("graphs/photo.json");
        let mut g: serde_json::Value = serde_json::from_slice(&fs::read(&graph_path).unwrap()).unwrap();
        let node = json!({"id":"kept", "type":"heeler.file", "params":{"path":copy.path}});
        g["versions"][0]["group"] = json!({"nodes":[node.clone()]});
        g["versions"][1]["group"] = json!({"nodes":[{"type":"heeler.file", "textParams":{"path":copy.path}}]});
        fs::write(&graph_path, serde_json::to_vec(&g).unwrap()).unwrap();
        let preset_path = "presets/Personal/Copy.heelerpreset";
        fs::write(f.data.join(preset_path), serde_json::to_vec(&json!({"nodes":[node],"wires":[]})).unwrap()).unwrap();
        f.catalog.add_image("kept", Path::new(&copy.path), None).unwrap();
        assert!(make(&f).complete);
        fs::rename(&vision, f.temp.path().join("old-vision-offline")).unwrap();
        let verified = verify(&f.bundle).unwrap();
        assert!(verified.complete, "{:?}", verified.problems);
        assert_eq!(verified.required_inputs, 1);
        assert!(verified.notes.is_empty(), "{:?}", verified.notes);
        let dest = f.temp.path().join("restored");
        fs::create_dir(&dest).unwrap();
        restore(&f.bundle, &dest).unwrap();
        let restored: serde_json::Value = serde_json::from_slice(&fs::read(dest.join("graphs/photo.json")).unwrap()).unwrap();
        let a = restored["versions"][0]["group"]["nodes"][0]["params"]["path"].as_str().unwrap();
        let b = restored["versions"][1]["group"]["nodes"][0]["textParams"]["path"].as_str().unwrap();
        assert_eq!(a, b);
        // Stored in the usual form (on Windows never `\\?\C:\...`): the
        // path the catalog and the graphs hold is one a user can read.
        assert!(Path::new(a).starts_with(crate::plain_path(fs::canonicalize(&dest).unwrap())), "{a}");
        assert!(!a.starts_with(r"\\?\"), "{a}");
        assert_eq!(fs::read(a).unwrap(), bytes);
        let decoded = heeler_io::decode_any(Path::new(a)).unwrap();
        assert_eq!((decoded.width, decoded.height), (6, 4));
        let preset: serde_json::Value = serde_json::from_slice(&fs::read(dest.join(preset_path)).unwrap()).unwrap();
        assert_eq!(preset["nodes"][0]["params"]["path"].as_str(), Some(a));
        let (_, rows) = Catalog::recovery_inventory(&dest.join("catalog.sqlite")).unwrap();
        assert!(rows.iter().any(|(id, path, _)| id == "kept" && path == a));
        // The restored state must itself be recoverable, including its new paths.
        let catalog = Catalog::open(&dest.join("catalog.sqlite")).unwrap();
        let next = f.temp.path().join("second.heeler-recovery");
        assert!(create(&catalog, &dest.join("catalog.sqlite"), &dest, &next).unwrap().complete);
        // Closed before its folder goes offline: Windows refuses to move
        // a folder holding an open file (Access is denied), as it would
        // refuse a user moving a running app's catalog folder.
        drop(catalog);
        fs::rename(&dest, f.temp.path().join("second-store-offline")).unwrap();
        assert!(verify(&next).unwrap().complete);
        // Integrity checks read retained pixels, never the unavailable source store.
        let (m, _, _, _) = inspect(&f.bundle).unwrap();
        let kept = m.files.iter().find(|f| f.path.starts_with("vision/layercopies/")).unwrap();
        fs::write(f.bundle.join(&kept.path), b"damaged").unwrap();
        assert!(!verify(&f.bundle).unwrap().complete);
    }

    #[test]
    fn missing_finish_layer_copy_never_publishes_a_complete_bundle() {
        let f = fixture();
        let missing = f.data.join("vision/layercopies/000000000000002a.tif");
        let graph_path = f.data.join("graphs/photo.json");
        let mut g: serde_json::Value = serde_json::from_slice(&fs::read(&graph_path).unwrap()).unwrap();
        g["nodes"].as_array_mut().unwrap().push(json!({"type":"heeler.file", "textParams":{"path":missing}}));
        fs::write(&graph_path, serde_json::to_vec(&g).unwrap()).unwrap();
        assert!(create(&f.catalog, &f.data.join("catalog.sqlite"), &f.data, &f.bundle).is_err());
        assert!(!f.bundle.exists());
    }

    /// The preference (Preferences > Backup, Keep baked pictures in
    /// backups) is on by default and read from the saved settings.
    #[test]
    fn keeping_baked_pictures_is_on_unless_the_saved_settings_say_off() {
        let f = fixture();
        assert!(keeps_finish_pictures(&f.catalog), "no saved settings");
        f.catalog.set_meta("ui_settings", r#"{"prefs":{"backupEveryDays":0}}"#).unwrap();
        assert!(keeps_finish_pictures(&f.catalog), "settings saved before the choice");
        f.catalog.set_meta("ui_settings", r#"{"prefs":{"keepBakedInBackups":false}}"#).unwrap();
        assert!(!keeps_finish_pictures(&f.catalog));
        f.catalog.set_meta("ui_settings", r#"{"prefs":{"keepBakedInBackups":true}}"#).unwrap();
        assert!(keeps_finish_pictures(&f.catalog));
        f.catalog.set_meta("ui_settings", "not json").unwrap();
        assert!(keeps_finish_pictures(&f.catalog), "unreadable is on");
    }

    /// Off (2026-10-01: "give the choice to them"): the bundle records a
    /// Finish picture by path and checksum only, as before 2026-10-01, and
    /// does not count it as a required input. Lost afterwards, the bundle
    /// still verifies complete and restores, with a note; the restored layer
    /// points at the old path, and the layer shows its file as missing.
    #[test]
    fn with_baked_pictures_left_out_a_lost_one_is_a_note_and_the_rest_restores() {
        let f = fixture();
        f.catalog.set_meta("ui_settings", r#"{"prefs":{"keepBakedInBackups":false}}"#).unwrap();
        let vision = f.temp.path().join("custom-vision");
        let image = heeler_engine::ImageBuf::filled(6, 4, [0.2, 0.4, 0.6, 0.5]);
        let cut = crate::layer_copy::cut_shown(&image).unwrap();
        let copy = crate::layer_copy::keep_copy(&vision, 42, &cut).unwrap();
        let bytes = fs::read(&copy.path).unwrap();
        let graph_path = f.data.join("graphs/photo.json");
        let mut g: serde_json::Value = serde_json::from_slice(&fs::read(&graph_path).unwrap()).unwrap();
        g["versions"][0]["group"] = json!({"nodes":[{"id":"kept", "type":"heeler.file", "params":{"path":copy.path}}]});
        fs::write(&graph_path, serde_json::to_vec(&g).unwrap()).unwrap();
        let made = make(&f);
        assert!(made.complete, "{:?}", made.problems);
        assert_eq!(made.required_inputs, 0, "not a required input");
        assert!(made.notes.iter().any(|n| n.contains("1 Layer via Copy or Bake Warp picture is not in this bundle")), "{:?}", made.notes);
        let (m, _, _, _) = inspect(&f.bundle).unwrap();
        assert!(!m.finish_pictures_kept);
        assert!(!m.files.iter().any(|e| e.path.starts_with("vision/")), "no Finish picture copied");
        let asset = m.assets.iter().find(|a| a.path == copy.path).unwrap();
        assert_eq!(asset.bytes, Some(bytes.len() as u64), "recorded by size");
        assert_eq!(asset.sha256.as_deref(), Some(format!("{:x}", Sha256::digest(&bytes)).as_str()), "and checksum");
        // Present, it verifies complete with only the left-out line.
        let verified = verify(&f.bundle).unwrap();
        assert!(verified.complete, "{:?}", verified.problems);
        assert_eq!(verified.notes.len(), 1, "{:?}", verified.notes);
        // Lost, still complete; the note names it.
        fs::rename(&vision, f.temp.path().join("old-vision-offline")).unwrap();
        let verified = verify(&f.bundle).unwrap();
        assert!(verified.complete, "{:?}", verified.problems);
        assert!(verified.notes.iter().any(|n| n.starts_with(&copy.path) && n.contains("missing")), "{:?}", verified.notes);
        let dest = f.temp.path().join("restored");
        fs::create_dir(&dest).unwrap();
        let restored = restore(&f.bundle, &dest).unwrap();
        assert!(restored.complete);
        assert!(restored.notes.iter().any(|n| n.starts_with(&copy.path)));
        let back: serde_json::Value = serde_json::from_slice(&fs::read(dest.join("graphs/photo.json")).unwrap()).unwrap();
        assert_eq!(back["versions"][0]["group"]["nodes"][0]["params"]["path"].as_str(), Some(copy.path.as_str()), "still its old path");
        assert!(!Path::new(&copy.path).exists());
        let probe = crate::file_layer_probe(None, &copy.path, "");
        assert_eq!(probe.missing, Some(format!("The file is missing. It was at {}", copy.path)));
        // Original photographs and the rest restore as ever.
        assert!(dest.join("catalog.sqlite").is_file());
    }

    /// Off, a Finish picture already missing when the bundle is made is
    /// a note, where on it stops the bundle
    /// (missing_finish_layer_copy_never_publishes_a_complete_bundle).
    #[test]
    fn with_baked_pictures_left_out_one_already_missing_is_a_note() {
        let f = fixture();
        f.catalog.set_meta("ui_settings", r#"{"prefs":{"keepBakedInBackups":false}}"#).unwrap();
        let missing = f.data.join("vision/layercopies/000000000000002a.tif");
        let graph_path = f.data.join("graphs/photo.json");
        let mut g: serde_json::Value = serde_json::from_slice(&fs::read(&graph_path).unwrap()).unwrap();
        g["nodes"].as_array_mut().unwrap().push(json!({"type":"heeler.file", "textParams":{"path":missing}}));
        fs::write(&graph_path, serde_json::to_vec(&g).unwrap()).unwrap();
        let made = make(&f);
        assert!(made.complete, "{:?}", made.problems);
        assert!(made.notes.iter().any(|n| n.starts_with(&missing.to_string_lossy().into_owned()) && n.contains("missing")), "{:?}", made.notes);
        let dest = f.temp.path().join("restored");
        fs::create_dir(&dest).unwrap();
        assert!(restore(&f.bundle, &dest).unwrap().complete);
    }

    /// 2026-10-01: a bundle in a Desktop folder verified as "Incomplete ... Bundle
    /// file inventory differs from its contents". The macOS file browser writes
    /// .DS_Store into any folder it shows, a bundle included; files like that are the
    /// operating system's, never a difference in the bundle.
    #[test]
    fn files_the_operating_system_adds_to_a_bundle_are_not_an_inventory_difference() {
        let f = fixture();
        assert!(make(&f).complete);
        fs::write(f.bundle.join(".DS_Store"), b"file browser").unwrap();
        fs::write(f.bundle.join("graphs/.DS_Store"), b"file browser").unwrap();
        fs::write(f.bundle.join("graphs/._photo.json"), b"appledouble").unwrap();
        // A custom folder icon's file; a carriage return is not a legal
        // file name character on Windows, so no Windows folder holds one.
        if cfg!(not(windows)) {
            fs::write(f.bundle.join("Icon\r"), b"").unwrap();
        }
        fs::create_dir_all(f.bundle.join(".Spotlight-V100/Store-V2")).unwrap();
        fs::write(f.bundle.join(".Spotlight-V100/Store-V2/index"), b"spotlight").unwrap();
        fs::write(f.bundle.join("Thumbs.db"), b"thumbnails").unwrap();
        fs::write(f.bundle.join("desktop.ini"), b"[.ShellClassInfo]").unwrap();
        fs::write(f.bundle.join("graphs/Desktop.ini"), b"[.ShellClassInfo]").unwrap();
        let checked = verify(&f.bundle).unwrap();
        assert!(checked.complete, "{:?}", checked.problems);
        let dest = f.temp.path().join("restored");
        fs::create_dir(&dest).unwrap();
        assert!(restore(&f.bundle, &dest).is_ok());
        assert!(!dest.join(".DS_Store").exists() && !dest.join("graphs/.DS_Store").exists());
    }

    /// File-browser files in app data stay out of a new bundle.
    #[test]
    fn a_new_bundle_leaves_out_the_operating_systems_files_in_app_data() {
        let f = fixture();
        fs::write(f.data.join("graphs/.DS_Store"), b"file browser").unwrap();
        fs::write(f.data.join("presets/._Personal"), b"appledouble").unwrap();
        assert!(make(&f).complete);
        assert!(!f.bundle.join("graphs/.DS_Store").exists());
        assert!(!f.bundle.join("presets/._Personal").exists());
    }

    /// A file that is not the operating system's and not in the manifest
    /// is named, and it does not hide what the sources check finds.
    #[test]
    fn an_unlisted_file_is_named_and_the_sources_are_still_checked() {
        let f = fixture();
        make(&f);
        fs::write(f.bundle.join("graphs/stray.json"), b"{}").unwrap();
        fs::remove_file(&f.original).unwrap();
        let checked = verify(&f.bundle).unwrap();
        assert!(!checked.complete);
        assert!(checked.problems.iter().any(|p| p.contains("1 file its manifest does not list: graphs/stray.json")), "{:?}", checked.problems);
        assert_eq!(checked.missing_originals, vec![f.original.to_string_lossy().into_owned()]);
        assert!(checked.problems.iter().any(|p| p.starts_with("1 original file is missing")), "{:?}", checked.problems);
    }

    /// 2026-10-01: the bundle "had some errors I think from missing
    /// files". Missing originals (photographs on a drive that is not
    /// plugged in) are one line that counts them, names the drive and the
    /// first few paths, with the full list beside it; never an inventory
    /// difference, and the bundle itself stays whole.
    #[test]
    fn missing_originals_are_counted_and_named_not_an_inventory_difference() {
        let f = fixture();
        // This platform's unplugged drive: `/Volumes/<name>` on a Mac, an
        // unused drive letter on Windows. The paths are joined by the OS,
        // so the line reads in one kind of separator.
        let root = crate::trash::unplugged_root();
        let volume = root.to_string_lossy().into_owned();
        let mut gone = Vec::new();
        for i in 0..4 {
            let p = root.join(format!("P{i}.RW2"));
            f.catalog.add_image(&format!("gone{i}"), &p, None).unwrap();
            gone.push(p.to_string_lossy().into_owned());
        }
        let local = f.temp.path().join("moved.png");
        f.catalog.add_image("moved", &local, None).unwrap();
        gone.push(local.to_string_lossy().into_owned());
        gone.sort();
        let made = make(&f);
        assert!(!made.complete);
        assert_eq!(made.problems.len(), 1, "{:?}", made.problems);
        let line = &made.problems[0];
        assert!(line.starts_with(&format!("5 original files are missing (not mounted: {volume}): ")), "{line}");
        assert!(line.contains(&gone[0]) && line.contains(", and 2 more."), "{line}");
        assert!(!line.contains(if cfg!(windows) { '/' } else { '\\' }), "one kind of separator: {line}");
        assert_eq!(made.missing_originals, gone);
        // The file browser looked inside: the verdict is the same line, nothing
        // about the inventory.
        fs::write(f.bundle.join(".DS_Store"), b"file browser").unwrap();
        let checked = verify(&f.bundle).unwrap();
        assert_eq!(checked.problems, made.problems);
        assert_eq!(checked.missing_originals, gone);
        assert!(!checked.problems.iter().any(|p| p.contains("manifest")));
    }

    // 2026-10-01: verify listed 84 bird and 40 star frames as missing at
    // `.trash/P1075868_0000NN.jpg` while they were in their folders. Only
    // the MEDIAN and MAX stacks were trashed; their members, named against
    // the folder the stack was made in, were resolved against the `.trash`
    // the stack had moved to.
    #[test]
    fn a_trashed_stack_leaves_its_members_where_they_are() {
        let f = fixture();
        let shoot = f.temp.path().join("bird_sequence");
        fs::create_dir(&shoot).unwrap();
        for (id, name) in [("m1", "P1.jpg"), ("m2", "P2.jpg"), ("back", "P3.jpg")] {
            fs::write(shoot.join(name), name.as_bytes()).unwrap();
            f.catalog.add_image(id, &shoot.join(name), None).unwrap();
        }
        let stack = shoot.join("MEDIAN_P1-P2.stack");
        fs::write(&stack, br#"{"members":["P1.jpg","P2.jpg"]}"#).unwrap();
        f.catalog.add_image("stack", &stack, None).unwrap();
        let trashed_stack = crate::trash::move_to_trash(&stack, "stack").unwrap();
        f.catalog.set_trashed("stack", true).unwrap();
        // A frame trashed and put back is a live photograph again.
        crate::trash::move_to_trash(&shoot.join("P3.jpg"), "back").unwrap();
        f.catalog.set_trashed("back", true).unwrap();
        crate::trash::restore_from_trash(&shoot.join("P3.jpg"), "back").unwrap();
        f.catalog.set_trashed("back", false).unwrap();

        let made = make(&f);
        assert!(made.complete, "{:?}", made.problems);
        assert!(made.missing_originals.is_empty(), "{:?}", made.missing_originals);
        let (m, problems, notes, _) = inspect(&f.bundle).unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        assert!(notes.is_empty(), "{notes:?}");
        let recipe = format!("recipe:{}", trashed_stack.display());
        for name in ["P1.jpg", "P2.jpg"] {
            let live = shoot.join(name).to_string_lossy().into_owned();
            let asset = m.assets.iter().find(|a| a.path == live).expect("member at its live path");
            assert!(asset.references.contains(&recipe), "{:?}", asset.references);
            assert!(asset.error.is_none());
        }
        assert!(m.assets.iter().any(|a| a.path == trashed_stack.to_string_lossy() && a.error.is_none()));
        assert!(m.assets.iter().any(|a| a.path == shoot.join("P3.jpg").to_string_lossy() && a.error.is_none()));
        assert!(!m.assets.iter().any(|a| a.path.contains("/.trash/P")), "{:?}", m.assets);
    }

    /// The trash index names the file: a collision in `.trash` gives it
    /// a numbered name, and the inventory reads that name.
    #[test]
    fn a_trashed_photograph_is_inventoried_under_the_name_the_trash_index_gave_it() {
        let f = fixture();
        let shot = f.temp.path().join("IMG_1.jpg");
        fs::write(&shot, b"this photograph").unwrap();
        f.catalog.add_image("shot", &shot, None).unwrap();
        let trash = f.temp.path().join(".trash");
        fs::create_dir(&trash).unwrap();
        fs::write(trash.join("IMG_1.jpg"), b"last week's IMG_1, not in this catalog").unwrap();
        let moved = crate::trash::move_to_trash(&shot, "shot").unwrap();
        f.catalog.set_trashed("shot", true).unwrap();
        assert_eq!(moved, trash.join("IMG_1 (2).jpg"));

        let made = make(&f);
        assert!(made.complete, "{:?}", made.problems);
        let (m, problems, _, _) = inspect(&f.bundle).unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        let asset = m.assets.iter().find(|a| a.references == vec!["catalog:shot".to_string()]).unwrap();
        assert_eq!(asset.path, moved.to_string_lossy());
        assert_eq!(asset.bytes, Some(b"this photograph".len() as u64));
    }

    /// 2026-10-01: "If a file in .trash is not found, I think its clear the
    /// user removed it." A note with the count and the folder, never a
    /// missing original, and the bundle restores.
    #[test]
    fn a_trashed_photograph_whose_file_left_the_trash_is_a_note() {
        let f = fixture();
        let shoot = f.temp.path().join("TEST");
        fs::create_dir(&shoot).unwrap();
        for name in ["DSCF1.dng", "DSCF2.dng"] {
            fs::write(shoot.join(name), name.as_bytes()).unwrap();
            f.catalog.add_image(name, &shoot.join(name), None).unwrap();
            crate::trash::move_to_trash(&shoot.join(name), name).unwrap();
            f.catalog.set_trashed(name, true).unwrap();
        }
        // Emptied by hand outside Heeler (moved out of the temp tree's
        // .trash, so the test removes nothing).
        let elsewhere = f.temp.path().join("emptied");
        fs::create_dir(&elsewhere).unwrap();
        for name in ["DSCF1.dng", "DSCF2.dng"] {
            fs::rename(shoot.join(".trash").join(name), elsewhere.join(name)).unwrap();
        }
        let made = make(&f);
        assert!(made.complete, "{:?}", made.problems);
        assert!(made.missing_originals.is_empty(), "{:?}", made.missing_originals);
        let trash = shoot.join(".trash").to_string_lossy().into_owned();
        assert_eq!(made.notes.len(), 1, "{:?}", made.notes);
        assert_eq!(made.notes[0], format!("2 trashed photographs are no longer in their .trash folder (removed outside Heeler): {trash}. Their edits are in the bundle"));
        let checked = verify(&f.bundle).unwrap();
        assert!(checked.complete, "{:?}", checked.problems);
        assert_eq!(checked.notes, made.notes);
        assert!(checked.missing_originals.is_empty());
        let dest = f.temp.path().join("restored");
        fs::create_dir(&dest).unwrap();
        let restored = restore(&f.bundle, &dest).unwrap();
        assert_eq!(restored.notes, made.notes);
    }

    /// A file moved outside Heeler stays a missing original; when the
    /// catalog also holds a file with that name, the report says where.
    #[test]
    fn a_missing_original_names_a_same_named_file_the_catalog_holds() {
        let f = fixture();
        let root = f.temp.path().join("Photography");
        let dated = root.join("2025-11-23");
        fs::create_dir_all(&dated).unwrap();
        fs::write(dated.join("P1551346.RW2"), b"raw").unwrap();
        f.catalog.add_image("old", &root.join("P1551346.RW2"), None).unwrap();
        f.catalog.add_image("new", &dated.join("P1551346.RW2"), None).unwrap();
        let made = make(&f);
        assert!(!made.complete);
        let gone = root.join("P1551346.RW2").to_string_lossy().into_owned();
        assert_eq!(made.missing_originals, vec![gone.clone()]);
        let hint = format!("{gone} is missing, and a file with the same name is at {}", dated.join("P1551346.RW2").display());
        assert!(made.notes.iter().any(|n| n.starts_with(&hint)), "{:?}", made.notes);
        let checked = verify(&f.bundle).unwrap();
        assert_eq!(checked.notes, made.notes);
    }
}

/// A pixel mask's bake is a saved edit's only input, as a converted
/// selection's is (2026-09-30: selections made into layer masks are
/// pixel masks): its own pointer, and the bake under a frozen live
/// selection a saved layer opened as.
#[cfg(test)]
mod pixel_mask_inputs {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_pixel_masks_bake_and_its_frozen_selections_bake_are_kept() {
        let frozen = json!({"regions": "[]", "strokes": "[]", "matte_id": "baked:00000000000000bb"}).to_string();
        let graph = json!({"nodes": [
            {"id": "art_m_a", "type": "heeler.brush_mask", "params": {}, "textParams": {"matte_id": "baked:00000000000000aa"}},
            {"id": "art_m_b", "type": "heeler.brush_mask", "params": {}, "textParams": {"base_selection": frozen}},
            {"id": "art_m_c", "type": "heeler.brush_mask", "params": {}, "strokes": []},
        ]});
        let mut out = BTreeSet::new();
        required_rasters(&graph, &mut out).unwrap();
        assert_eq!(out, BTreeSet::from([0xaa, 0xbb]));
    }

    /// A baked Warp layer keeps the Warp layer's definition for Unbake
    /// (NodeCard.bakedFrom, 2026-10-01), its pixel mask by its bake's
    /// pointer: a bundle and the Storage clear (referenced_rasters) keep
    /// that bake, as they keep a live mask's, though no live mask points
    /// at it.
    #[test]
    fn an_unbake_definitions_mask_bake_is_kept() {
        let graph = json!({"nodes": [{"id": "art_g", "type": "heeler.group", "groupNodes": [
            {"id": "art_p1", "type": "heeler.file", "textParams": {"path": "/v/layercopies/00000000000000bb.tif", "origin": "bake"},
             "bakedFrom": {
                "carrier": {"id": "art_b1", "type": "heeler.blend", "params": {"opacity": 100}},
                "content": {"id": "art_p1", "type": "heeler.layer_warp", "params": {}},
                "fx": [],
                "mask": {"id": "art_m_art_b1", "type": "heeler.brush_mask", "params": {}, "textParams": {"matte_id": "baked:00000000000000cc"}}
             }}
        ]}]});
        let mut out = BTreeSet::new();
        required_rasters(&graph, &mut out).unwrap();
        assert_eq!(out, BTreeSet::from([0xcc]));
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("graphs")).unwrap();
        std::fs::write(dir.path().join("graphs/photo.json"), serde_json::to_vec(&graph).unwrap()).unwrap();
        assert_eq!(referenced_rasters(dir.path()).unwrap(), BTreeSet::from([0xcc]));
    }
}

/// A recovery bundle of a real catalog, for testing what the owner
/// would otherwise test by hand (2026-10-01: "I feel like
/// #4 Recovery should be testable on your end"). Ignored and gated:
/// HEELER_RECOVERY_REAL_CATALOG names a COPY of the catalog (made with
/// SQLite's backup from a read-only connection, never a file copy),
/// HEELER_RECOVERY_REAL_DATA the app data folder, read only (recovery
/// copies out of it and writes nothing there), HEELER_RECOVERY_REAL_OUT
/// a scratch folder the bundle is written into (as `bundle`, which must
/// not exist yet). It makes a bundle, verifies it twice and once more
/// with .DS_Store files dropped into it, asserts the verifications
/// agree with the creation, and prints every report plus what Forget
/// Missing Trashed Photos would list over the copy. The app finishes
/// pending saves before a bundle; there is no app here, so the bundle
/// is of what is on disk.
/// `HEELER_RECOVERY_REAL_CATALOG=<copy> HEELER_RECOVERY_REAL_DATA=<app data> HEELER_RECOVERY_REAL_OUT=<scratch> cargo test -p heeler-desktop --lib real_recovery -- --ignored --nocapture`
#[cfg(test)]
mod real_recovery_tests {
    use super::*;

    fn print(what: &str, r: &Report) {
        println!("== {what}: {}", r.path);
        println!("complete: {}", r.complete);
        println!(
            "photographs {} graphs {} takes {} presets {} assets {} baked inputs (required_inputs) {} app {}",
            r.images, r.graphs, r.takes, r.presets, r.assets, r.required_inputs, r.app_version
        );
        println!("problems ({}):", r.problems.len());
        for p in &r.problems {
            println!("  P: {p}");
        }
        println!("notes ({}):", r.notes.len());
        for n in &r.notes {
            println!("  N: {n}");
        }
        println!("missing originals ({}):", r.missing_originals.len());
        for m in &r.missing_originals {
            println!("  M: {m}");
        }
    }
    fn same(a: &Report, b: &Report) {
        assert_eq!(
            (a.complete, a.images, a.graphs, a.takes, a.presets, a.assets, a.required_inputs),
            (b.complete, b.images, b.graphs, b.takes, b.presets, b.assets, b.required_inputs)
        );
        assert_eq!(a.problems, b.problems);
        assert_eq!(a.notes, b.notes);
        assert_eq!(a.missing_originals, b.missing_originals);
    }
    fn size(at: &Path) -> u64 {
        fs::read_dir(at)
            .unwrap()
            .map(|e| {
                let e = e.unwrap();
                if e.file_type().unwrap().is_dir() {
                    size(&e.path())
                } else {
                    e.metadata().unwrap().len()
                }
            })
            .sum()
    }

    #[test]
    #[ignore]
    fn real_recovery_bundle_of_a_catalog_copy() {
        let (Ok(copy), Ok(data), Ok(out)) = (
            std::env::var("HEELER_RECOVERY_REAL_CATALOG"),
            std::env::var("HEELER_RECOVERY_REAL_DATA"),
            std::env::var("HEELER_RECOVERY_REAL_OUT"),
        ) else {
            return;
        };
        let (copy, data, out) = (Path::new(&copy), Path::new(&data), Path::new(&out));
        assert!(!copy.starts_with(data), "use a copy outside app data");
        let catalog = Catalog::open(copy).unwrap();
        let rows = catalog
            .list_trashed(None)
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.path))
            .collect::<Vec<_>>();
        let forget = crate::trash::missing_trashed(&rows);
        println!("== Forget Missing Trashed Photos over the copy: {} of {} trashed", forget.ids.len(), rows.len());
        for (id, path) in forget.ids.iter().zip(&forget.paths) {
            println!("  F: {path} ({id})");
        }
        println!("skipped {} on {:?}", forget.skipped, forget.skipped_volumes);

        let dest = out.join("bundle");
        let started = std::time::Instant::now();
        let made = create(&catalog, copy, data, &dest).unwrap();
        println!("created in {:.1} s, {} bytes", started.elapsed().as_secs_f64(), size(&dest));
        print("create", &made);
        let started = std::time::Instant::now();
        let first = verify(&dest).unwrap();
        println!("verified in {:.1} s", started.elapsed().as_secs_f64());
        print("verify 1", &first);
        let second = verify(&dest).unwrap();
        same(&first, &second);
        fs::write(dest.join(".DS_Store"), b"Bud1").unwrap();
        fs::write(dest.join("graphs/.DS_Store"), b"Bud1").unwrap();
        let third = verify(&dest).unwrap();
        same(&first, &third);
        same(&made, &first);
        println!("verified three times alike (twice, then with .DS_Store files)");
    }
}
