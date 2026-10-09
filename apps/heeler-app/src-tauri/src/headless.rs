//! Headless serving: `heeler serve <catalog>`, the NAS and home-server
//! snapshot export story. Same snapshot-and-serve model as the in-app
//! share, no GUI: the installed binary doubles as the server when
//! launched with the subcommand.
//!
//! The renderer is the same code the app's export uses (render_export
//! over decode_any_with), and the graphs are the same per-image files
//! the app saves, so what this serves is what the editor would show.
//! Members with no saved edits render through a bare source-to-output
//! graph: the photograph as decoded, nothing invented.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::{
    load_graph_file, render_export, sanitize_id, serve, source_opts_of, UiConnection, UiGraph,
    UiNode,
};

/// The bundle identifier, which MUST match tauri.conf.json: it is the
/// folder name every platform hangs this app's data off.
pub(crate) const IDENT: &str = "com.vagabondburro.heeler";

/// The per-user data root, WITHOUT the identifier: the folder the app's
/// own directory sits inside.
fn data_root() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        xdg_data_home(std::env::var_os("XDG_DATA_HOME"), std::env::var_os("HOME"))
    }
}

/// Tauri's app_data_dir without Tauri: the platform data dir plus the
/// bundle identifier from tauri.conf.json. Headless runs need it for
/// the saved graphs, which the GUI put there.
pub(crate) fn appdata_dir() -> Option<PathBuf> {
    data_root().map(|d| d.join(IDENT))
}

/// $XDG_DATA_HOME when set and non-empty, else ~/.local/share. Tauri's
/// app_data_dir resolves through the same rule on Linux, and GUI and
/// headless MUST agree on the answer or headless opens every photo
/// unedited, hunting graphs in a folder the app never wrote. Pure over
/// its two inputs so the precedence is unit-testable from any OS.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn xdg_data_home(
    xdg: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    match xdg {
        Some(d) if !d.is_empty() => Some(PathBuf::from(d)),
        _ => home.map(|h| PathBuf::from(h).join(".local/share")),
    }
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// The unedited fallback: source straight into output. Honest, and
/// deliberately NOT a re-creation of the app's default look; keeping
/// that recipe in one place (the frontend) beats a drifting copy here.
fn bare_graph() -> UiGraph {
    UiGraph {
        graph_id: "headless-bare".into(),
        nodes: vec![
            UiNode {
                id: "src".into(),
                node_type: "heeler.image_source".into(),
                enabled: true,
                params: Default::default(),
            },
            UiNode {
                id: "out".into(),
                node_type: "heeler.output".into(),
                enabled: true,
                params: Default::default(),
            },
        ],
        connections: vec![UiConnection { from: ("src".into(), "rgb".into()), to: ("out".into(), "rgb".into()) }],
    }
}

#[derive(Debug)]
struct Snapshot {
    name: String,
    items: Vec<serve::ServeItem>,
    dir: PathBuf,
    skipped: Vec<String>,
    unedited: usize,
}

/// The name that says a directory is ours to write into.
const SERVE_MARKER: &str = ".heeler-serve";

/// Makes the render directory ready without deleting anything.
///
/// `--cache` is whatever the caller typed, and this used to open by
/// emptying it recursively: `heeler serve cat.db --cache ~/Pictures`
/// would have taken the pictures. Nothing in this app removes a file
/// somebody else made, so the rule is now a marker. We will write into a
/// directory we created, and into an empty one, and into one we have
/// used before; anything else is somebody's folder and we refuse it by
/// name rather than guess. Renders overwrite by filename, so a reused
/// directory needs no sweeping, and a stale file from an older run is
/// simply never referenced by the manifest.
fn prepare_serve_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        let ours = dir.join(SERVE_MARKER).exists();
        let empty = std::fs::read_dir(dir)
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
            .next()
            .is_none();
        if !ours && !empty {
            return Err(format!(
                "refusing to render into {}: it already has files in it and heeler did not \
                 make it. Point --cache at a new or empty directory.",
                dir.display()
            ));
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(SERVE_MARKER), b"heeler serve renders live here\n")
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renders one collection into a serve directory. Factored off the CLI
/// so the whole pipeline tests without a terminal.
fn snapshot(
    catalog: &heeler_catalog::Catalog,
    collection: &str,
    graphs_dir: &Path,
    out_dir: &Path,
    max_edge: u32,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Result<Snapshot, String> {
    let collections = catalog.collection_summaries().map_err(|e| e.to_string())?;
    let found = collections
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(collection))
        .ok_or_else(|| {
            let names: Vec<&str> = collections.iter().map(|c| c.name.as_str()).collect();
            format!(
                "no collection named \"{collection}\". This catalog has: {}",
                if names.is_empty() { "none".to_string() } else { names.join(", ") }
            )
        })?;
    let records = catalog
        .list_images(&heeler_catalog::Filter {
            min_rating: None,
            flag: None,
            extension: None,
            folder_id: None,
            collection_id: Some(found.id),
            keyword: None,
            include_hidden: false,
        })
        .map_err(|e| e.to_string())?;
    prepare_serve_dir(out_dir)?;

    // The same model-store override the GUI resolves: headless serving
    // must look for models and smart-mask rasters where the app put them.
    let vision = appdata_dir().map(|d| crate::vision_base_offline(d.join("vision"), Some(catalog)));
    let mut items = Vec::new();
    let mut skipped = Vec::new();
    let mut unedited = 0usize;
    let total = records.len();
    for (i, rec) in records.iter().enumerate() {
        progress(i + 1, total, &rec.file_name);
        // Stacks and panoramas are recipes over other frames, and their
        // merge pipeline is session-bound today. Named, not silent.
        if heeler_catalog::is_pano(&rec.extension) || heeler_catalog::is_stack(&rec.extension) {
            skipped.push(format!("{} (stacks and panoramas need the app)", rec.file_name));
            continue;
        }
        // A damaged file is an error, never an unedited photograph.
        let saved = match load_graph_file(graphs_dir, &rec.id) {
            Ok(saved) => saved,
            Err(e) => { skipped.push(format!("{} ({e})", rec.file_name)); continue; }
        };
        let ui = match saved.and_then(|json| crate::ui_graph_from_saved(&json))
        {
            Some(g) => g,
            None => {
                unedited += 1;
                bare_graph()
            }
        };
        let opts = source_opts_of(&ui);
        let source = match heeler_io::decode_any_with(Path::new(&rec.path), opts) {
            Ok(img) => Arc::new(img),
            Err(e) => {
                skipped.push(format!("{} ({e})", rec.file_name));
                continue;
            }
        };
        heeler_engine::memory::budget().track_image(&source);
        // Smart masks: the GUI's disk cache first, recomputed from the
        // recipe when the model is installed here, empty otherwise.
        let mut smart = vision
            .as_deref()
            .map(|base| crate::smart_sources_offline(base, &ui, &rec.id, &source, Some(std::path::Path::new(&rec.path))))
            .unwrap_or_default();
        // A Catalog node's other photograph, rendered the same offline way.
        let path_of = |id: &str| catalog.image(id).ok().map(|r| std::path::PathBuf::from(r.path));
        if let Err(e) = crate::plant_catalog_sources_offline(graphs_dir, &path_of, &ui, &mut smart, &rec.id, 0) {
            skipped.push(format!("{} ({e})", rec.file_name));
            continue;
        }
        let mut image = match render_export(&ui, source, &smart) {
            Ok(img) => img,
            Err(e) => {
                skipped.push(format!("{} ({e})", rec.file_name));
                continue;
            }
        };
        if max_edge > 0 {
            image = crate::downscale(&image, max_edge as usize);
        }
        // WebP, matching the in-app share: the server routes and pages
        // speak one extension whoever produced the snapshot.
        let bytes = match heeler_io::encode_webp(&image, 85) {
            Ok(b) => b,
            Err(e) => {
                skipped.push(format!("{} ({e})", rec.file_name));
                continue;
            }
        };
        std::fs::write(out_dir.join(format!("{}.webp", sanitize_id(&rec.id))), bytes)
            .map_err(|e| e.to_string())?;
        items.push(serve::ServeItem { id: rec.id.clone(), name: rec.file_name.clone(), v: 0 });
    }
    Ok(Snapshot {
        name: found.name.clone(),
        items,
        dir: out_dir.to_path_buf(),
        skipped,
        unedited,
    })
}

fn usage() -> String {
    "usage: heeler serve <catalog.sqlite or its folder> --collection NAME\n       \
     [--port N] [--max-edge PX (default 2560, 0 = full size)]\n       \
     [--graphs DIR] [--cache DIR]\n\n\
     Run without --collection to list what the catalog offers."
        .into()
}

/// The subcommand. Returns the process exit code.
pub fn serve_main(args: &[String]) -> i32 {
    match run(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("heeler serve: {e}");
            1
        }
    }
}

fn run(args: &[String]) -> Result<i32, String> {
    let catalog_arg = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .ok_or_else(usage)?;
    let mut catalog_path = PathBuf::from(catalog_arg);
    if catalog_path.is_dir() {
        catalog_path = catalog_path.join(crate::DEFAULT_CATALOG);
    }
    if !catalog_path.exists() {
        return Err(format!("no catalog at {}", catalog_path.display()));
    }
    // The same gate the GUI's open paths pass through (26.3): an older
    // catalog is never migrated without the user's backup choice, which
    // headless cannot ask for, so it names the GUI door instead.
    if let Ok(Some((from, to))) = heeler_catalog::Catalog::pending_upgrade(&catalog_path) {
        return Err(crate::upgrade_pending_error_headless(&catalog_path, from, to));
    }

    let appdata = appdata_dir().ok_or("no home directory")?;
    let catalog = heeler_catalog::Catalog::open(&catalog_path).map_err(|e| e.to_string())?;

    let Some(collection) = flag(args, "--collection") else {
        let summaries = catalog.collection_summaries().map_err(|e| e.to_string())?;
        if summaries.is_empty() {
            println!("This catalog has no collections. Build one in Heeler first;\nthe collection is the boundary of what gets served.");
        } else {
            println!("Collections in {}:", catalog_path.display());
            for c in &summaries {
                println!("  {}  ({} photos)", c.name, c.image_count);
            }
            println!("\nServe one with: heeler serve \"{}\" --collection \"{}\"", catalog_arg, summaries[0].name);
        }
        return Ok(0);
    };

    let graphs_dir = flag(args, "--graphs")
        .map(PathBuf::from)
        .unwrap_or_else(|| appdata.join("graphs"));
    let cache_dir = flag(args, "--cache")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("heeler-serve"));
    // Stable by default, like the GUI: the same port each run keeps the
    // shared link alive across restarts. --port 0 asks the OS instead.
    let explicit_port = flag(args, "--port").is_some();
    let port: u16 = match flag(args, "--port") {
        Some(p) => p.parse().map_err(|_| "--port must be a number")?,
        None => serve::PREFERRED_PORT,
    };
    let max_edge: u32 = match flag(args, "--max-edge") {
        Some(m) => m.parse().map_err(|_| "--max-edge must be a number of pixels")?,
        None => 2560,
    };

    println!("Rendering \"{collection}\"...");
    let snap = snapshot(&catalog, &collection, &graphs_dir, &cache_dir, max_edge, &mut |i, n, name| {
        println!("  [{i}/{n}] {name}");
    })?;
    for s in &snap.skipped {
        println!("  skipped: {s}");
    }
    if snap.unedited > 0 {
        println!(
            "  note: {} photo(s) have no saved edits here and serve as straight decodes\n  \
             (saved edits live in {}; point --graphs there if this is not the editing machine)",
            snap.unedited,
            graphs_dir.display()
        );
    }
    if snap.items.is_empty() {
        return Err("nothing to serve: every member was skipped".into());
    }

    let token = appdata_dir().map(|d| serve::persistent_token(&d));
    let status = serve::start(
        snap.name.clone(),
        snap.items.clone(),
        snap.dir.clone(),
        &format!("0.0.0.0:{port}"),
        token.clone(),
        false,
    )
    .or_else(|e| {
        // The stable default port being busy should not kill a share
        // nobody pinned to a number; an explicitly asked-for port should
        // fail honestly.
        if explicit_port {
            Err(e)
        } else {
            serve::start(snap.name.clone(), snap.items, snap.dir, "0.0.0.0:0", token, false)
        }
    })?;
    println!();
    println!("Serving \"{}\" ({} photos)", status.name, status.count);
    println!("  {}", status.url);
    println!("Anyone on this network with the link can view. Ctrl+C stops the share.");
    // The server lives on its own thread; this one just holds the door.
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    /// XDG precedence, exercised from any OS: a set XDG_DATA_HOME wins,
    /// an empty one does not count as set, and HOME
    /// alone lands on ~/.local/share.
    #[test]
    fn xdg_data_home_precedence() {
        let take = super::xdg_data_home(
            Some(OsString::from("/xdg")),
            Some(OsString::from("/home/user")),
        );
        assert_eq!(take, Some(std::path::PathBuf::from("/xdg")));
        let empty = super::xdg_data_home(Some(OsString::new()), Some(OsString::from("/home/user")));
        assert_eq!(empty, Some(std::path::PathBuf::from("/home/user/.local/share")));
        let bare = super::xdg_data_home(None, Some(OsString::from("/home/user")));
        assert_eq!(bare, Some(std::path::PathBuf::from("/home/user/.local/share")));
        assert_eq!(super::xdg_data_home(None, None), None);
    }

    /// The identifier is the folder name on every platform, so a
    /// tauri.conf.json that disagrees with this constant means the
    /// GUI and headless look in different directories.
    #[test]
    fn matches_the_bundle_identifier_in_tauri_conf() {
        let conf = include_str!("../tauri.conf.json");
        assert!(
            conf.contains(&format!("\"identifier\": \"{}\"", super::IDENT)),
            "tauri.conf.json does not declare {}",
            super::IDENT
        );
    }

    use super::*;

    /// The whole headless pipeline against a real (temp) catalog: an
    /// edited member renders through its saved graph, an unedited one
    /// falls back to the bare graph, and the files land where the
    /// server will look for them.
    #[test]
    fn snapshot_renders_a_collection_end_to_end() {
        let tmp = tempfile::tempdir().unwrap();
        // A tiny real image on disk, PNG so no raw decoder is involved.
        let mut img = heeler_engine::ImageBuf::new(8, 6);
        for px in img.data.chunks_exact_mut(4) {
            px.copy_from_slice(&[0.5, 0.25, 0.1, 1.0]);
        }
        let png = heeler_io::encode_png(&img).unwrap();
        let photo = tmp.path().join("shot.png");
        std::fs::write(&photo, png).unwrap();

        let catalog = heeler_catalog::Catalog::open(&tmp.path().join("catalog.sqlite")).unwrap();
        let folder = catalog.add_folder(tmp.path()).unwrap();
        catalog.add_image("img_1", &photo, Some(folder)).unwrap();
        let coll = catalog.create_collection("Family").unwrap();
        catalog.add_to_collection(coll, "img_1").unwrap();

        // No graphs dir at all: the bare-graph fallback carries it.
        let out = tmp.path().join("serve");
        let snap = snapshot(&catalog, "family", &tmp.path().join("nowhere"), &out, 0, &mut |_, _, _| {})
            .unwrap();
        assert_eq!(snap.name, "Family", "matched case-insensitively");
        assert_eq!(snap.items.len(), 1);
        assert_eq!(snap.unedited, 1);
        assert!(out.join("img_1.webp").exists(), "the render landed for the server");

        // An unknown collection names what IS there.
        let err = snapshot(&catalog, "Vacation", &tmp.path(), &out, 0, &mut |_, _, _| {})
            .unwrap_err();
        assert!(err.contains("Family"), "the error lists real collections: {err}");
    }

    #[test]
    fn the_bare_graph_builds_and_renders() {
        let ui = bare_graph();
        let mut img = heeler_engine::ImageBuf::new(4, 4);
        for px in img.data.chunks_exact_mut(4) {
            px.copy_from_slice(&[0.2, 0.4, 0.6, 1.0]);
        }
        let out = render_export(&ui, Arc::new(img), &std::collections::HashMap::new()).expect("bare graph renders");
        assert_eq!((out.width, out.height), (4, 4));
    }

    /// "I don't want ANY code that deletes files to exist in
    /// this app." `--cache` is a path the caller types, and the old
    /// opener was a recursive emptying of it, so a typo naming somebody's
    /// picture folder was a wipe of somebody's picture folder.
    #[test]
    fn a_render_directory_that_is_somebodys_folder_is_refused_not_emptied() {
        let tmp = tempfile::tempdir().unwrap();
        let theirs = tmp.path().join("Pictures");
        std::fs::create_dir_all(&theirs).unwrap();
        let keepsake = theirs.join("wedding.NEF");
        std::fs::write(&keepsake, b"a negative").unwrap();

        let err = prepare_serve_dir(&theirs).unwrap_err();
        assert!(err.contains("refusing"), "{err}");
        assert!(keepsake.exists(), "it took the photograph");

        // Empty is ours to take, and having taken it once we keep it.
        let ours = tmp.path().join("renders");
        prepare_serve_dir(&ours).unwrap();
        std::fs::write(ours.join("001.webp"), b"a render").unwrap();
        prepare_serve_dir(&ours).unwrap();
        assert!(ours.join("001.webp").exists(), "a reuse swept the directory");
    }
}
