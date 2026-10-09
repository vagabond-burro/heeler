//! Batch mode: `Heeler.exe -x script.heeler`, a compositor's gesture. The
//! installed binary runs a Python script against the catalog with no
//! window, which is how render-farm and cron-style automation works
//! everywhere scripts grew up.
//!
//! There is no webview in batch, so there are no frontend reducers.
//! Instead a small native session holds one current image and its
//! saved graph, and a native bridge answers the same methods the
//! in-app bridge answers, for the subset that makes sense without a
//! UI: catalog listing, rating and flagging, opening an image, editing
//! its graph, saving, rendering. Anything view-shaped refuses by
//! naming batch mode, so a script never half-works silently.
//!
//! The Python side is identical to everywhere else: the module-level
//! `heeler` functions, wired by HEELER_API_PORT / HEELER_API_TOKEN.

use std::io::{BufRead as _, BufReader, Write as _};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

struct Current {
    id: String,
    name: String,
    path: String,
    graph: serde_json::Value,
}

pub struct BatchState {
    /// Mutexed for Sync: the sqlite connection is Send, not Sync, and
    /// the server thread shares this state with the main one.
    catalog: Mutex<heeler_catalog::Catalog>,
    graphs_dir: PathBuf,
    current: Mutex<Option<Current>>,
}

impl BatchState {
    fn catalog(&self) -> Result<std::sync::MutexGuard<'_, heeler_catalog::Catalog>, String> {
        self.catalog.lock().map_err(|_| "catalog poisoned".into())
    }
}

/// A fresh graph for an image never edited: source into output,
/// the same shape headless serving falls back to.
fn bare_graph_json() -> serde_json::Value {
    serde_json::json!({
        "graph_id": "batch",
        "nodes": [
            { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
            { "id": "out", "type": "heeler.output", "enabled": true, "params": {} }
        ],
        "connections": [ { "from": ["src", "rgb"], "to": ["out", "rgb"] } ]
    })
}

/// The saved graph a batch renders or edits from: the file's, unless
/// there is none, or it is the pre-defaults demo edit the app itself
/// reads as absent (is_legacy_demo_graph); then the bare pass-through,
/// so a script sees the photograph the app shows.
fn saved_graph_doc(state: &BatchState, id: &str) -> Result<serde_json::Value, String> {
    Ok(crate::load_graph_file(&state.graphs_dir, id)?
        .filter(|json| !crate::is_legacy_demo_graph(json))
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_else(bare_graph_json))
}

fn registry() -> &'static heeler_graph::Registry {
    static R: std::sync::OnceLock<heeler_graph::Registry> = std::sync::OnceLock::new();
    R.get_or_init(heeler_graph::Registry::builtin)
}

fn refuse(what: &str) -> String {
    format!("{what} is not available in batch mode; it needs the app open")
}

// Export naming, mirrored from the frontend's export.ts (fillTemplate,
// sanitizeFilename, destinationFor): the batch door must name files
// exactly the way the panel does, or a script and a click would write
// two different trees from one template.

/// The extension each format writes. png16 shares .png with its 8-bit
/// sibling: it IS a PNG, just one with sixteen bits per channel, and the
/// format string breaks the tie where the extension cannot.
fn export_ext(format: &str) -> Option<&'static str> {
    match format {
        "jpeg" => Some("jpg"),
        "webp" => Some("webp"),
        "png" | "png16" => Some("png"),
        "tiff" | "tiff32" => Some("tif"),
        "dng" => Some("dng"),
        "exr" => Some("exr"),
        _ => None,
    }
}

/// Strips a filename down to something every platform will take.
/// Windows is the strict one: reserved device names, and trailing dots
/// and spaces it would silently drop, turning two distinct exports into
/// one file that overwrites itself.
fn sanitize_filename(name: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '|' | '?' | '*' | '\\' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    while out.ends_with('.') || out.ends_with(' ') {
        out.pop();
    }
    let lower = out.to_ascii_lowercase();
    let reserved = matches!(lower.as_str(), "con" | "prn" | "aux" | "nul")
        || (lower.starts_with("com") || lower.starts_with("lpt"))
            && lower.len() == 4
            && lower.chars().last().map(|c| c.is_ascii_digit()).unwrap_or(false)
            && lower.chars().last() != Some('0');
    if reserved {
        out = format!("_{out}");
    }
    let truncated: String = out.chars().take(120).collect();
    if truncated.is_empty() { "untitled".to_string() } else { truncated }
}

/// Fills a filename template for one image. `{name}` is the original
/// filename without its extension, `{n}` the position in the batch
/// padded so a folder of exports sorts the way it was shot. Unknown
/// tokens are left alone, so a typo shows up in the name instead of
/// producing a wrong one quietly.
fn fill_template(template: &str, file_name: &str, index: usize, total: usize, stars: u8, flag: &str) -> String {
    let stem = file_name.rsplit_once('.').map(|(s, _)| s).unwrap_or(file_name);
    let width = total.to_string().len();
    let n = format!("{:0width$}", index + 1, width = width);
    let flag = if flag.is_empty() { "none" } else { flag };
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open..];
        match after.find('}') {
            Some(close) => {
                let token = &after[1..close];
                // Word tokens only, the same shape the frontend fills.
                if !token.is_empty() && token.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    match token {
                        "name" => out.push_str(stem),
                        "n" => out.push_str(&n),
                        "stars" => out.push_str(&stars.to_string()),
                        "flag" => out.push_str(flag),
                        _ => out.push_str(&after[..=close]),
                    }
                } else {
                    out.push_str(&after[..=close]);
                }
                rest = &after[close + 1..];
            }
            None => {
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    sanitize_filename(&out)
}

/// The full destination for one image, extension included. A name the
/// run already used grows a -2, -3 suffix instead of overwriting: a
/// RAW+JPEG pair shares one stem, and the template cannot see that.
#[allow(clippy::too_many_arguments)]
fn export_destination(
    dir: &str,
    ext: &str,
    template: &str,
    file_name: &str,
    index: usize,
    total: usize,
    stars: u8,
    flag: &str,
    taken: &mut std::collections::HashSet<String>,
) -> PathBuf {
    let sep = if dir.contains('\\') && !dir.contains('/') { "\\" } else { "/" };
    let trimmed = dir.trim_end_matches(['/', '\\']);
    let base = fill_template(template, file_name, index, total, stars, flag);
    let mut name = base.clone();
    let mut k = 2;
    while taken.contains(&name.to_ascii_lowercase()) {
        name = format!("{base}-{k}");
        k += 1;
    }
    taken.insert(name.to_ascii_lowercase());
    PathBuf::from(format!("{trimmed}{sep}{name}.{ext}"))
}

/// The UiGraph a saved document renders from: the engine-shape copy
/// under `render` when the file carries one, the document itself for
/// bare graphs and legacy fixtures. The same rule render.preview uses.
fn ui_graph_of(doc: &serde_json::Value) -> Result<crate::UiGraph, String> {
    doc.get("render")
        .and_then(|r| serde_json::from_value(r.clone()).ok())
        .or_else(|| serde_json::from_value(doc.clone()).ok())
        .ok_or_else(|| {
            "this image's saved graph predates the embedded render graph; \
             open it in the app and save once"
                .to_string()
        })
}

/// One image through the export pipeline, batch side. The render,
/// encode, metadata and write are finish_export, the same function the
/// panel's export_to ends in, so a script's files are the panel's
/// files; the caller collects failures rather than dying on the first.
#[allow(clippy::too_many_arguments)]
fn export_one(
    state: &BatchState,
    id: &str,
    index: usize,
    total: usize,
    dir: &str,
    ext: &str,
    template: &str,
    format: &str,
    quality: u8,
    max_edge: Option<u32>,
    keep_metadata: bool,
    matte: bool,
    dpi: u32,
    taken: &mut std::collections::HashSet<String>,
) -> Result<String, String> {
    let (name, path, stars, flag) = {
        let rec = state
            .catalog()?
            .image(id)
            .map_err(|e| format!("not in this catalog: {e}"))?;
        let flag = match rec.flag {
            heeler_catalog::Flag::Pick => "pick",
            heeler_catalog::Flag::Reject => "reject",
            heeler_catalog::Flag::None => "",
        };
        (rec.file_name.clone(), rec.path.clone(), rec.rating, flag)
    };
    // The open image exports its live graph, which may be newer than
    // what has been written to disk; every other image exports its
    // saved graph, and a never-edited one its bare pass-through.
    let doc = {
        let current = state.current.lock().map_err(|_| "session poisoned")?;
        match current.as_ref() {
            Some(c) if c.id == id => c.graph.clone(),
            _ => saved_graph_doc(state, id)?,
        }
    };
    let ui = ui_graph_of(&doc)?;
    let source_path = PathBuf::from(&path);
    if !source_path.exists() {
        return Err(format!("the original is missing or moved: {path}"));
    }
    let source = Arc::new(
        heeler_io::decode_any_with(&source_path, crate::source_opts_of(&ui))
            .map_err(|e| e.to_string())?,
    );
    let smart = {
        let catalog = state.catalog().ok();
        crate::headless::appdata_dir()
            .map(|d| crate::vision_base_offline(d.join("vision"), catalog.as_deref()))
            .map(|base| crate::smart_sources_offline(&base, &ui, id, &source, Some(&source_path)))
            .unwrap_or_default()
    };
    let keywords = if keep_metadata {
        state.catalog()?.keywords_of(id).unwrap_or_default()
    } else {
        Vec::new()
    };
    let dest = export_destination(dir, ext, template, &name, index, total, stars, flag, taken);
    // The Output node's alpha port and the graph's Export Layer nodes
    // (26.3 Phase 8), rendered through one executor before the beauty's
    // own, so a shared mask subtree computes once.
    let (alpha, layers) = crate::render_export_layers(&ui, source.clone(), &smart, |level, msg| {
        eprintln!("export {level}: {name}: {msg}");
    })?;
    crate::finish_export(
        crate::ExportInput {
            graph: &ui,
            source_path: Some(&source_path),
            source,
            smart: &smart,
            keywords: &keywords,
            alpha,
            layers,
        },
        &dest,
        crate::ExportOptions {
            format,
            quality,
            max_edge,
            keep_metadata,
            matte,
            scale_percent: None,
            // Batch mode has no dialog either; a taken name moves aside.
            allow_overwrite: false,
            dpi,
        },
        |level, msg| eprintln!("export {level}: {name}: {msg}"),
    )
}

/// export.run, batch side: the same per-image loop the frontend's
/// runExport performs, reporting success and failure per image rather
/// than dying on the first.
fn export_run(state: &BatchState, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let dir = params
        .get("dir")
        .and_then(|d| d.as_str())
        .filter(|d| !d.is_empty())
        .ok_or("export.run needs { dir }")?;
    let format = params.get("format").and_then(|f| f.as_str()).unwrap_or("jpeg");
    let ext = export_ext(format).ok_or_else(|| {
        format!("export.run: format must be one of jpeg, webp, png, png16, tiff, tiff32, dng, exr (got \"{format}\")")
    })?;
    let quality = params.get("quality").and_then(|q| q.as_u64()).unwrap_or(92) as u8;
    let max_edge = params.get("maxEdge").and_then(|m| m.as_u64()).map(|m| m as u32);
    let template = params.get("template").and_then(|t| t.as_str()).unwrap_or("{name}");
    let keep_metadata = params.get("keepMetadata").and_then(|k| k.as_bool()).unwrap_or(true);
    let matte = params.get("matte").and_then(|m| m.as_bool()).unwrap_or(false);
    // The print resolution the files declare, as the export panel's.
    let dpi = heeler_io::resolution::normalize_dpi(params.get("dpi").and_then(|d| d.as_f64()));

    // The run's targets: the ids asked for, or the open image, the way
    // the panel exports the selection or falls back to the active one.
    let ids: Vec<String> = match params.get("ids").and_then(|i| i.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        None => {
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            vec![current
                .as_ref()
                .ok_or("no image open; pass ids or call heeler.open_image(id) first")?
                .id
                .clone()]
        }
    };
    let total = ids.len();
    let mut written: Vec<String> = Vec::new();
    let mut failed: Vec<serde_json::Value> = Vec::new();
    let mut taken = std::collections::HashSet::new();
    for (i, id) in ids.iter().enumerate() {
        match export_one(
            state, id, i, total, dir, ext, template, format, quality, max_edge, keep_metadata,
            matte, dpi, &mut taken,
        ) {
            Ok(dest) => written.push(dest),
            Err(e) => failed.push(serde_json::json!({ "name": id, "error": e })),
        }
    }
    Ok(serde_json::json!({ "written": written, "failed": failed }))
}

/// Applies `apply` to node `id` wherever it lives in the saved doc:
/// the editor's node list, and the engine-shape copy under `render`
/// when the file carries one. Both must move together, or a batch
/// edit would render one way and save another.
fn mutate_node(
    graph: &mut serde_json::Value,
    id: &str,
    apply: impl Fn(&mut serde_json::Value),
) -> Result<(), String> {
    let mut hit = false;
    if let Some(n) = graph
        .get_mut("nodes")
        .and_then(|n| n.as_array_mut())
        .and_then(|nodes| nodes.iter_mut().find(|n| n["id"] == id))
    {
        apply(n);
        hit = true;
    }
    if let Some(n) = graph
        .get_mut("render")
        .and_then(|r| r.get_mut("nodes"))
        .and_then(|n| n.as_array_mut())
        .and_then(|nodes| nodes.iter_mut().find(|n| n["id"] == id))
    {
        apply(n);
        hit = true;
    }
    if hit {
        Ok(())
    } else {
        Err(format!("no node \"{id}\" in this graph"))
    }
}

fn node_type_of(graph: &serde_json::Value, id: &str) -> Result<String, String> {
    for list in [graph.get("nodes"), graph.get("render").and_then(|r| r.get("nodes"))] {
        if let Some(n) = list
            .and_then(|n| n.as_array())
            .and_then(|nodes| nodes.iter().find(|n| n["id"] == id))
        {
            return Ok(n["type"].as_str().unwrap_or("").to_string());
        }
    }
    Err(format!("no node \"{id}\" in this graph"))
}

fn dispatch_command(state: &BatchState, cmd: &serde_json::Value) -> Result<serde_json::Value, String> {
    let ctype = cmd.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let mut current = state.current.lock().map_err(|_| "session poisoned")?;
    match ctype {
        "select_image" => {
            let id = cmd["id"].as_str().ok_or("select_image needs an id")?;
            let rec = state.catalog()?.image(id).map_err(|e| e.to_string())?;
            let graph = saved_graph_doc(state, id)?;
            *current = Some(Current {
                id: id.to_string(),
                name: rec.file_name.clone(),
                path: rec.path.clone(),
                graph,
            });
            Ok(serde_json::json!({ "opened": id }))
        }
        "set_param" => {
            let cur = current.as_mut().ok_or("no image open; call heeler.open_image(id) first")?;
            let id = cmd["id"].as_str().ok_or("set_param needs a node id")?;
            let param = cmd["param"].as_str().ok_or("set_param needs a param name")?;
            let mut value = cmd.get("value").cloned().ok_or("set_param needs a value")?;
            // The house rule, same as the app's fields: typing may pass
            // the slider, never the physics. Hard limits are zero-or-
            // unbounded and the UI-to-registry scales are positive, so
            // clamping the UI-space value against the registry's floor
            // is exact, no unit conversion needed.
            if let Some(v) = value.as_f64() {
                let ntype = node_type_of(&cur.graph, id)?;
                if let Some((reg_name, _)) = crate::map_param(&ntype, param, v) {
                    if let Some(p) = registry()
                        .get(&ntype)
                        .and_then(|spec| spec.params.iter().find(|p| p.name == reg_name))
                    {
                        let (lo, hi) = heeler_graph::spec::hard_limits(p);
                        let clamped = v.clamp(lo, hi);
                        if clamped != v {
                            value = serde_json::json!(clamped);
                        }
                    }
                }
            }
            mutate_node(&mut cur.graph, id, |n| n["params"][param] = value.clone())?;
            Ok(serde_json::json!({ "dispatched": "set_param" }))
        }
        "set_enabled" => {
            let cur = current.as_mut().ok_or("no image open; call heeler.open_image(id) first")?;
            let id = cmd["id"].as_str().ok_or("set_enabled needs a node id")?;
            let enabled = cmd["enabled"].as_bool().unwrap_or(true);
            mutate_node(&mut cur.graph, id, |n| n["enabled"] = serde_json::json!(enabled))?;
            Ok(serde_json::json!({ "dispatched": "set_enabled" }))
        }
        "set_rating" => {
            let stars = cmd["stars"].as_u64().unwrap_or(0).min(5) as u8;
            for id in cmd["ids"].as_array().map(|a| a.as_slice()).unwrap_or_default() {
                if let Some(id) = id.as_str() {
                    state.catalog()?.set_rating(id, stars).map_err(|e| e.to_string())?;
                }
            }
            Ok(serde_json::json!({ "dispatched": "set_rating" }))
        }
        "set_flag" => {
            let flag = match cmd["flag"].as_str().unwrap_or("") {
                "pick" => heeler_catalog::Flag::Pick,
                "reject" => heeler_catalog::Flag::Reject,
                _ => heeler_catalog::Flag::None,
            };
            for id in cmd["ids"].as_array().map(|a| a.as_slice()).unwrap_or_default() {
                if let Some(id) = id.as_str() {
                    state.catalog()?.set_flag(id, flag).map_err(|e| e.to_string())?;
                }
            }
            Ok(serde_json::json!({ "dispatched": "set_flag" }))
        }
        other => Err(refuse(&format!("command \"{other}\""))),
    }
}

pub fn handle(state: &BatchState, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    match method {
        "app.ping" => Ok(serde_json::json!({ "heeler": 1, "app": "heeler", "mode": "batch" })),
        "registry.nodes" => Ok(crate::api::registry_manifest()),
        "app.state" => {
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            Ok(match current.as_ref() {
                Some(c) => serde_json::json!({ "mode": "batch", "imageId": c.id, "imageName": c.name }),
                None => serde_json::json!({ "mode": "batch", "imageId": null, "imageName": null }),
            })
        }
        "catalog.images" => {
            let records = state
                .catalog()?
                .list_images(&heeler_catalog::Filter {
                    min_rating: None,
                    flag: None,
                    extension: None,
                    folder_id: None,
                    collection_id: None,
                    keyword: None,
                    include_hidden: false,
                })
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Array(
                records
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "id": r.id, "name": r.file_name, "stars": r.rating,
                            "flag": match r.flag {
                                heeler_catalog::Flag::Pick => "pick",
                                heeler_catalog::Flag::Reject => "reject",
                                heeler_catalog::Flag::None => "",
                            },
                            "path": r.path,
                        })
                    })
                    .collect(),
            ))
        }
        "graph.get" => {
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            let cur = current.as_ref().ok_or("no image open; call heeler.open_image(id) first")?;
            // The engine-shape copy is the truth about what renders
            // (groups arrive flattened there); the top-level keys are
            // the fallback for bare graphs and legacy fixtures.
            let engine = cur.graph.get("render").unwrap_or(&cur.graph);
            Ok(serde_json::json!({
                "nodes": engine.get("nodes").cloned().unwrap_or_default(),
                "wires": engine.get("connections").cloned().unwrap_or_default(),
                "selection": [],
            }))
        }
        "graph.command" => {
            let cmd = params.get("command").cloned().ok_or("no command")?;
            dispatch_command(state, &cmd)
        }
        "catalog.collections" => {
            let sums = state
                .catalog()?
                .collection_summaries()
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Array(
                sums.iter()
                    .map(|c| {
                        serde_json::json!({
                            "id": c.id, "name": c.name,
                            "count": c.image_count,
                            "hasLook": c.graph_id.is_some(),
                        })
                    })
                    .collect(),
            ))
        }
        "takes.list" => {
            // Read-only in batch: the takes live in the saved document,
            // so listing them needs no reducer. Creating, switching and
            // deleting are reducer work and refuse like the other
            // app-door commands.
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            let cur = current.as_ref().ok_or("no image open; call heeler.open_image(id) first")?;
            let versions = cur.graph.get("versions").and_then(|v| v.as_array());
            let takes: Vec<serde_json::Value> = match versions {
                Some(v) if !v.is_empty() => v
                    .iter()
                    .map(|t| {
                        serde_json::json!({
                            "id": t["id"], "name": t["name"],
                            "note": t.get("note").cloned().unwrap_or(serde_json::Value::Null),
                        })
                    })
                    .collect(),
                // An image never branched has one implicit take: the
                // edit itself, the same answer the app door gives.
                _ => vec![serde_json::json!({ "id": "take_1", "name": "Take 1", "note": null })],
            };
            let active = cur
                .graph
                .get("activeVersion")
                .and_then(|a| a.as_str())
                .unwrap_or("take_1");
            Ok(serde_json::json!({ "imageId": cur.id, "active": active, "takes": takes }))
        }
        "export.run" => export_run(state, &params),
        "graph.save" => {
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            let cur = current.as_ref().ok_or("no image open; nothing to save")?;
            // A photograph never edited in the app has no editor-shaped
            // graph to save into: the bare pass-through is engine shape
            // only, and a file in that shape is one the app reports as
            // damaged the next time the photograph opens.
            if cur.graph.get("wires").and_then(|w| w.as_array()).is_none() {
                return Err(format!(
                    "{} has no saved edits for graph.save to update. Open it in Heeler and change something once; a script can edit and save it from then on",
                    cur.name
                ));
            }
            // Through the revision gate the app's own saves use, so the
            // file carries a revision like every other graph and an older
            // retry can never replace a newer write.
            let loaded = cur.graph.get("revision").and_then(|v| v.as_u64()).unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_micros() as u64)
                .unwrap_or(0);
            crate::graphstore::save(&state.graphs_dir, &cur.id, &cur.graph.to_string(), now.max(loaded + 1), false)?;
            let _ = state.catalog()?.set_edited(&cur.id);
            Ok(serde_json::json!({ "saved": cur.id }))
        }
        "noise.estimate" => {
            // The NLF estimator against the SOURCE as decoded, the same
            // measurement the app's AUTO chip makes, so calibration
            // scripts read the same numbers the panel acts on.
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            let cur = current.as_ref().ok_or("no image open; call heeler.open_image(id) first")?;
            let ui: crate::UiGraph = cur
                .graph
                .get("render")
                .and_then(|r| serde_json::from_value(r.clone()).ok())
                .or_else(|| serde_json::from_value(cur.graph.clone()).ok())
                .ok_or("this image's saved graph predates the embedded render graph")?;
            let opts = crate::source_opts_of(&ui);
            let source = heeler_io::decode_any_with(std::path::Path::new(&cur.path), opts)
                .map_err(|e| e.to_string())?;
            let est = heeler_engine::noise::estimate_noise(&source);
            Ok(serde_json::json!({
                "luma_sigma": est.luma_sigma,
                "chroma_sigma": est.chroma_sigma,
            }))
        }
        "render.preview" => {
            let current = state.current.lock().map_err(|_| "session poisoned")?;
            let cur = current.as_ref().ok_or("no image open; call heeler.open_image(id) first")?;
            let ui: crate::UiGraph = cur
                .graph
                .get("render")
                .and_then(|r| serde_json::from_value(r.clone()).ok())
                .or_else(|| serde_json::from_value(cur.graph.clone()).ok())
                .ok_or(
                    "this image's saved graph predates the embedded render graph; \
                     open it in the app and save once",
                )?;
            let opts = crate::source_opts_of(&ui);
            let source = heeler_io::decode_any_with(std::path::Path::new(&cur.path), opts)
                .map_err(|e| e.to_string())?;
            let source = Arc::new(source);
            heeler_engine::memory::budget().track_image(&source);
            // Smart masks come from the disk cache or a recipe
            // recompute, same as headless.
            let mut smart = {
                let catalog = state.catalog().ok();
                crate::headless::appdata_dir()
                    .map(|d| crate::vision_base_offline(d.join("vision"), catalog.as_deref()))
                    .map(|base| crate::smart_sources_offline(&base, &ui, &cur.id, &source, Some(std::path::Path::new(&cur.path))))
                    .unwrap_or_default()
            };
            // A Catalog node's other photograph, rendered the same offline way.
            if let Ok(catalog) = state.catalog() {
                let path_of = |id: &str| catalog.image(id).ok().map(|r| std::path::PathBuf::from(r.path));
                crate::plant_catalog_sources_offline(&state.graphs_dir, &path_of, &ui, &mut smart, &cur.id, 0)?;
            }
            let image = crate::render_export(&ui, source, &smart)?;
            let quality = params.get("quality").and_then(|v| v.as_u64()).unwrap_or(92) as u8;
            let bytes = heeler_io::encode_jpeg(&image, quality.clamp(1, 100)).map_err(|e| e.to_string())?;
            use base64::Engine as _;
            Ok(serde_json::json!({
                "format": "jpeg",
                "width": image.width,
                "height": image.height,
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }))
        }
        other => Err(refuse(&format!("\"{other}\""))),
    }
}

/// The batch bridge: same wire shape as the in-app one, answered
/// natively, over the same bounded transport (body and header limits,
/// read and write deadlines, one serial dispatcher behind the socket
/// workers), so a stalled or oversized client cannot hold a batch run
/// either. Returns (port, token); the server lives until the process
/// exits, which in batch is the point, so its handle is deliberately
/// leaked rather than dropped shut.
pub fn start_server(state: Arc<BatchState>) -> Result<(u16, String), String> {
    let token = crate::serve::mint_token();
    let transport = crate::api_transport::Transport::start(
        token.clone(),
        Arc::new(move |method, params, _stop| handle(&state, method, params)),
    )?;
    let port = transport.port;
    std::mem::forget(transport);
    Ok((port, token))
}

/// `Heeler.exe -x script.heeler [--catalog PATH]`.
pub fn batch_main(args: &[String]) -> i32 {
    match run(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("heeler -x: {e}");
            1
        }
    }
}

fn flag_arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn run(args: &[String]) -> Result<i32, String> {
    let script = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .ok_or("usage: heeler -x <script.heeler or .py> [--catalog PATH]")?;
    let script = PathBuf::from(script);
    if !script.exists() {
        return Err(format!("no script at {}", script.display()));
    }

    let appdata = crate::headless::appdata_dir().ok_or("no home directory")?;
    let catalog_path = match flag_arg(args, "--catalog") {
        Some(p) => {
            let p = PathBuf::from(p);
            if p.is_dir() { p.join(crate::DEFAULT_CATALOG) } else { p }
        }
        None => crate::active_catalog_in(&appdata),
    };
    if !catalog_path.exists() {
        return Err(format!("no catalog at {}", catalog_path.display()));
    }
    // The same gate the GUI's open paths pass through (26.3): a batch
    // against an older catalog would migrate it sight unseen.
    if let Ok(Some((from, to))) = heeler_catalog::Catalog::pending_upgrade(&catalog_path) {
        return Err(crate::upgrade_pending_error_headless(&catalog_path, from, to));
    }
    let state = Arc::new(BatchState {
        catalog: Mutex::new(heeler_catalog::Catalog::open(&catalog_path).map_err(|e| e.to_string())?),
        graphs_dir: appdata.join("graphs"),
        current: Mutex::new(None),
    });
    let (port, token) = start_server(state)?;

    // The same driver the console uses, sent one "run" request.
    let dir = std::env::temp_dir().join("heeler-batch");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("heeler.py"), crate::py::CLIENT_PY).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("driver.py"), crate::py::DRIVER_PY).map_err(|e| e.to_string())?;
    let mut cmd = crate::py::python_command();
    cmd.arg("-u")
        .arg(dir.join("driver.py"))
        .current_dir(&dir)
        .env("HEELER_API_PORT", port.to_string())
        .env("HEELER_API_TOKEN", &token)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| {
        format!("could not start python: {e}. Python 3 must be installed and on PATH (as python or python3).")
    })?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let req = serde_json::json!({ "op": "run", "path": script.to_string_lossy() });
    writeln!(stdin, "{req}").map_err(|e| e.to_string())?;
    drop(stdin);
    let reply = BufReader::new(stdout)
        .lines()
        .next()
        .ok_or("python produced no reply")?
        .map_err(|e| e.to_string())?;
    let _ = child.wait();
    let v: serde_json::Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    let out = v.get("out").and_then(|x| x.as_str()).unwrap_or("");
    let err = v.get("err").and_then(|x| x.as_str()).unwrap_or("");
    if !out.is_empty() {
        print!("{out}");
    }
    if !err.is_empty() {
        eprint!("{err}");
        return Ok(1);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_one_image(tmp: &std::path::Path) -> (Arc<BatchState>, String) {
        let mut img = heeler_engine::ImageBuf::new(6, 4);
        for px in img.data.chunks_exact_mut(4) {
            px.copy_from_slice(&[0.6, 0.3, 0.2, 1.0]);
        }
        let photo = tmp.join("one.png");
        std::fs::write(&photo, heeler_io::encode_png(&img).unwrap()).unwrap();
        let catalog = heeler_catalog::Catalog::open(&tmp.join("catalog.sqlite")).unwrap();
        let folder = catalog.add_folder(tmp).unwrap();
        catalog.add_image("img_1", &photo, Some(folder)).unwrap();
        (
            Arc::new(BatchState {
                catalog: Mutex::new(catalog),
                graphs_dir: tmp.join("graphs"),
                current: Mutex::new(None),
            }),
            "img_1".to_string(),
        )
    }

    #[test]
    fn a_batch_session_lists_opens_edits_saves_and_renders() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());

        // The catalog answers like the app's bridge would.
        let imgs = handle(&state, "catalog.images", serde_json::Value::Null).unwrap();
        assert_eq!(imgs[0]["id"], "img_1");

        // Editing without opening is refused in words, not a panic.
        let err = handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "set_param", "id": "src", "param": "x", "value": 1 } }),
        )
        .unwrap_err();
        assert!(err.contains("open_image"), "{err}");

        // Open (bare graph: never edited), edit, read back, save.
        handle(&state, "graph.command", serde_json::json!({ "command": { "type": "select_image", "id": id } })).unwrap();
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "set_param", "id": "src", "param": "camera_wb", "value": 0 } }),
        )
        .unwrap();
        let g = handle(&state, "graph.get", serde_json::Value::Null).unwrap();
        assert_eq!(g["nodes"][0]["params"]["camera_wb"], 0);
        // A bare graph has no editor shape to save into. Writing the
        // engine shape used to produce a file the app reported as
        // damaged; now the script is told what to do and nothing is written.
        let err = handle(&state, "graph.save", serde_json::Value::Null).unwrap_err();
        assert!(err.contains("no saved edits") && err.contains("Open it in Heeler"), "{err}");
        assert!(!tmp.path().join("graphs").join("img_1.json").exists());

        // Rating and flagging land in the catalog.
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "set_rating", "ids": ["img_1"], "stars": 4 } }),
        )
        .unwrap();
        let imgs = handle(&state, "catalog.images", serde_json::Value::Null).unwrap();
        assert_eq!(imgs[0]["stars"], 4);

        // Rendering answers real pixels, base64-wrapped.
        let r = handle(&state, "render.preview", serde_json::Value::Null).unwrap();
        assert_eq!(r["width"], 6);
        assert!(r["base64"].as_str().unwrap().len() > 100);

        // View-shaped work refuses by naming batch mode.
        let err = handle(&state, "graph.serialize", serde_json::Value::Null).unwrap_err();
        assert!(err.contains("batch mode"), "{err}");
        let err = dispatch_command(&state, &serde_json::json!({ "type": "add_region" })).unwrap_err();
        assert!(err.contains("batch mode"), "{err}");
    }

    #[test]
    fn an_edited_photo_renders_through_its_embedded_engine_graph() {
        // The file the app saves: editor shape outside (layout, wires,
        // takes), engine shape under `render`. Batch renders from the
        // engine copy, edits land in BOTH copies, and save round-trips
        // the editor's keys untouched. This was every batch render of
        // an edited photo: the editor shape has no graph_id, so
        // render.preview refused before the graph even ran.
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        let saved = serde_json::json!({
            "activeVersion": "take_1",
            "backdrops": [],
            "versions": [],
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "name": "Source", "enabled": true, "params": {}, "x": 40, "y": 60 },
                { "id": "exp", "type": "heeler.exposure", "name": "Exposure", "enabled": true, "params": { "exposure": 1.0 }, "x": 240, "y": 60 },
                { "id": "out", "type": "heeler.output", "name": "Output", "enabled": true, "params": {}, "x": 440, "y": 60 }
            ],
            "wires": [
                { "from": "src", "to": "exp", "toPort": "in", "kind": "image" },
                { "from": "exp", "to": "out", "toPort": "in", "kind": "image" }
            ],
            "render": {
                "graph_id": "img_1_ui",
                "nodes": [
                    { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                    { "id": "exp", "type": "heeler.exposure", "enabled": true, "params": { "exposure": 1.0 } },
                    { "id": "out", "type": "heeler.output", "enabled": true, "params": {} }
                ],
                "connections": [
                    { "from": ["src", "out"], "to": ["exp", "in"] },
                    { "from": ["exp", "out"], "to": ["out", "in"] }
                ]
            }
        });
        crate::save_graph_file(&tmp.path().join("graphs"), &id, &saved.to_string()).unwrap();

        handle(&state, "graph.command", serde_json::json!({ "command": { "type": "select_image", "id": id } })).unwrap();
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "set_param", "id": "exp", "param": "exposure", "value": 2.0 } }),
        )
        .unwrap();

        // graph.get answers from the engine copy, edit included.
        let g = handle(&state, "graph.get", serde_json::Value::Null).unwrap();
        assert_eq!(g["nodes"][1]["params"]["exposure"], 2.0);
        assert_eq!(g["wires"][0]["from"][0], "src");

        // The render succeeds and runs the edited graph.
        let r = handle(&state, "render.preview", serde_json::Value::Null).unwrap();
        assert_eq!(r["width"], 6);
        assert_eq!(r["format"], "jpeg");

        // Save keeps the editor's shape whole: layout intact, both
        // parameter copies moved together.
        handle(&state, "graph.save", serde_json::Value::Null).unwrap();
        let file = std::fs::read_to_string(tmp.path().join("graphs").join("img_1.json")).unwrap();
        let doc: serde_json::Value = serde_json::from_str(&file).unwrap();
        assert_eq!(doc["nodes"][1]["x"], 240);
        assert_eq!(doc["nodes"][1]["params"]["exposure"], 2.0);
        assert_eq!(doc["render"]["nodes"][1]["params"]["exposure"], 2.0);
        assert_eq!(doc["activeVersion"], "take_1");
        // The save went through the revision gate: the file carries a
        // revision, and an older one cannot replace it afterwards.
        let revision = doc["revision"].as_u64().expect("a gated save stamps its revision");
        assert!(revision > 0);
        let older = crate::graphstore::save(&tmp.path().join("graphs"), &id, &saved.to_string(), revision - 1, false).unwrap_err();
        assert!(older.contains("older than"), "{older}");
    }

    #[test]
    fn the_legacy_demo_edit_is_absent_in_batch_as_it_is_in_the_app() {
        // The app reads the pre-defaults demo edit (exposure 0.62, 5480 K,
        // grain 14) as no edits at all. Batch exported it, so a script's
        // file of a photograph the app shows untouched came out warmed,
        // brightened and grained.
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        let demo = serde_json::json!({
            "nodes": [
                { "id": "exposure", "type": "heeler.exposure", "enabled": true, "params": { "exposure": 0.62 } },
                { "id": "stdcolor", "type": "heeler.stdcolor", "enabled": true, "params": { "temperature": 5480.0 } },
                { "id": "grain", "type": "heeler.grain", "enabled": true, "params": { "grain_amount": 14.0 } }
            ],
            "wires": []
        });
        crate::save_graph_file(&tmp.path().join("graphs"), &id, &demo.to_string()).unwrap();
        assert!(crate::is_legacy_demo_graph(&demo.to_string()));
        handle(&state, "graph.command", serde_json::json!({ "command": { "type": "select_image", "id": id } })).unwrap();
        let g = handle(&state, "graph.get", serde_json::Value::Null).unwrap();
        assert_eq!(g["nodes"].as_array().unwrap().len(), 2, "the bare pass-through, not the demo edit");
    }

    #[test]
    fn batch_edits_respect_the_hard_range_rule() {
        // The owner's rule, quoted at the fields: "for Radius you should
        // not be able to go below 0 but go as high as you want." Batch
        // scripts get the same physics, not a side door.
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        let saved = serde_json::json!({
            "graph_id": "g", "connections": [],
            "nodes": [
                { "id": "b1", "type": "heeler.blur", "enabled": true, "params": {} },
                { "id": "e1", "type": "heeler.exposure", "enabled": true, "params": {} }
            ]
        });
        crate::save_graph_file(&tmp.path().join("graphs"), &id, &saved.to_string()).unwrap();
        handle(&state, "graph.command", serde_json::json!({ "command": { "type": "select_image", "id": id } })).unwrap();

        let set = |node: &str, param: &str, v: f64| {
            handle(
                &state,
                "graph.command",
                serde_json::json!({ "command": { "type": "set_param", "id": node, "param": param, "value": v } }),
            )
            .unwrap();
        };
        set("b1", "radius", -3.0);
        set("e1", "exposure", 12.0);
        let g = handle(&state, "graph.get", serde_json::Value::Null).unwrap();
        let param_of = |nid: &str, p: &str| {
            g["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|n| n["id"] == nid)
                .unwrap()["params"][p]
                .clone()
        };
        assert_eq!(param_of("b1", "radius"), -0.0_f64, "a negative radius floors at zero");
        assert_eq!(param_of("e1", "exposure"), 12.0, "past the slider is allowed, physics is not");
    }

    #[test]
    fn the_batch_server_refuses_a_wrong_token() {
        use std::io::{Read as _, Write as _};
        let tmp = tempfile::tempdir().unwrap();
        let (state, _) = state_with_one_image(tmp.path());
        let (port, token) = start_server(state).unwrap();
        let ask = |tok: &str| -> String {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let body = r#"{"method":"app.ping"}"#;
            write!(
                s,
                "POST /rpc HTTP/1.1\r\nHost: x\r\nX-Heeler-Token: {tok}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            buf
        };
        assert!(ask("wrong").starts_with("HTTP/1.1 403"), "a bad token is a closed door");
        let good = ask(&token);
        assert!(good.contains("\"ok\":true"), "the right token answers: {good}");
    }

    /// The full loop, script to catalog: a real python process runs a
    /// real .heeler file against the batch server over HTTP. Skipped
    /// quietly where python is absent.
    #[test]
    fn a_heeler_script_runs_end_to_end() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, _) = state_with_one_image(tmp.path());
        let (port, token) = start_server(state.clone()).unwrap();

        std::fs::write(tmp.path().join("heeler.py"), crate::py::CLIENT_PY).unwrap();
        std::fs::write(tmp.path().join("driver.py"), crate::py::DRIVER_PY).unwrap();
        let script = tmp.path().join("job.heeler");
        std::fs::write(
            &script,
            "import heeler\nfor img in heeler.images():\n    heeler.rate(img['id'], 5)\nprint('rated', len(heeler.images()))\n",
        )
        .unwrap();

        let spawned = crate::py::python_command()
            .arg("-u")
            .arg(tmp.path().join("driver.py"))
            .current_dir(tmp.path())
            .env("HEELER_API_PORT", port.to_string())
            .env("HEELER_API_TOKEN", &token)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn();
        let Ok(mut child) = spawned else {
            eprintln!("python not on PATH; skipping");
            return;
        };
        let mut stdin = child.stdin.take().unwrap();
        writeln!(
            stdin,
            "{}",
            serde_json::json!({ "op": "run", "path": script.to_string_lossy() })
        )
        .unwrap();
        drop(stdin);
        let reply = BufReader::new(child.stdout.take().unwrap()).lines().next().unwrap().unwrap();
        let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["err"], "", "script ran clean");
        assert!(v["out"].as_str().unwrap().contains("rated 1"));
        let imgs = handle(&state, "catalog.images", serde_json::Value::Null).unwrap();
        assert_eq!(imgs[0]["stars"], 5, "the script's edit reached the catalog");
        let _ = child.wait();
    }

    #[test]
    fn every_bridge_method_works_in_batch_or_refuses_by_naming_it() {
        // The parity walk: the manifest is the same file the frontend
        // door's test reads, so the two doors cannot silently diverge.
        // Every method either answers natively here (the explicit list
        // below, asserted Ok) or refuses naming batch mode. A method
        // that falls through the match arms refuses too, which is why
        // the native list asserts Ok rather than merely not-refusing.
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../src/api-methods.json")).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        // A real-sized frame: the noise estimator walks blocks, and the
        // 6x4 fixture is smaller than one of them.
        let mut img = heeler_engine::ImageBuf::new(64, 64);
        for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
            let v = (i % 255) as f32 / 255.0;
            px.copy_from_slice(&[v, 0.4, 0.6, 1.0]);
        }
        let photo = tmp.path().join("frame.png");
        std::fs::write(&photo, heeler_io::encode_png(&img).unwrap()).unwrap();
        let catalog = heeler_catalog::Catalog::open(&tmp.path().join("catalog.sqlite")).unwrap();
        let folder = catalog.add_folder(tmp.path()).unwrap();
        catalog.add_image("img_1", &photo, Some(folder)).unwrap();
        let state = Arc::new(BatchState {
            catalog: Mutex::new(catalog),
            graphs_dir: tmp.path().join("graphs"),
            current: Mutex::new(None),
        });
        // The file the app saves, editor shape with the engine copy under
        // `render`: graph.save only updates edits the app has made, so the
        // walk saves what a script would find on an edited photograph.
        let saved = serde_json::json!({
            "activeVersion": "take_1", "backdrops": [], "versions": [],
            "nodes": [
                { "id": "src", "type": "heeler.image_source", "name": "Source", "enabled": true, "params": {}, "x": 40, "y": 60 },
                { "id": "out", "type": "heeler.output", "name": "Output", "enabled": true, "params": {}, "x": 440, "y": 60 }
            ],
            "wires": [ { "from": "src", "to": "out", "toPort": "in", "kind": "image" } ],
            "render": {
                "graph_id": "img_1_ui",
                "nodes": [
                    { "id": "src", "type": "heeler.image_source", "enabled": true, "params": {} },
                    { "id": "out", "type": "heeler.output", "enabled": true, "params": {} }
                ],
                "connections": [ { "from": ["src", "out"], "to": ["out", "in"] } ]
            }
        });
        crate::save_graph_file(&tmp.path().join("graphs"), "img_1", &saved.to_string()).unwrap();
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "select_image", "id": "img_1" } }),
        )
        .unwrap();

        let batch_native = [
            "app.ping",
            "app.state",
            "registry.nodes",
            "graph.get",
            "graph.command",
            "graph.save",
            "catalog.images",
            "catalog.collections",
            "takes.list",
            "render.preview",
            "noise.estimate",
            "export.run",
        ];
        let params_for = |m: &str| -> serde_json::Value {
            match m {
                "graph.command" => serde_json::json!({
                    // Enabled to true: a no-op edit, so the walk itself
                    // does not break the renders that come after it.
                    "command": { "type": "set_enabled", "id": "src", "enabled": true }
                }),
                "export.run" => serde_json::json!({
                    "dir": tmp.path().join("parity-out").to_string_lossy(),
                    "ids": ["img_1"],
                    "keepMetadata": false,
                }),
                _ => serde_json::Value::Null,
            }
        };
        let mut methods: Vec<String> = manifest["methods"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m.as_str().map(String::from))
            .collect();
        methods.extend(
            manifest["batch_only"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m.as_str().map(String::from)),
        );
        for m in &methods {
            let result = handle(&state, m, params_for(m));
            if batch_native.contains(&m.as_str()) {
                assert!(result.is_ok(), "{m} must work natively in batch: {result:?}");
            } else {
                let err = result.unwrap_err();
                assert!(
                    err.contains("batch mode"),
                    "{m} must refuse by naming batch mode, got: {err}"
                );
            }
        }
    }

    #[test]
    fn batch_take_mutations_refuse_by_naming_batch_mode() {
        // Takes are reducer work: history is per-take and switching
        // rewrites the session, so batch lists them (takes.list) and
        // refuses the rest, the way view-shaped commands already do.
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "select_image", "id": id } }),
        )
        .unwrap();
        for cmd in ["new_take", "switch_take", "update_take", "delete_take"] {
            let err = dispatch_command(&state, &serde_json::json!({ "type": cmd })).unwrap_err();
            assert!(err.contains("batch mode"), "{cmd}: {err}");
        }
    }

    #[test]
    fn takes_list_reads_the_saved_document() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        // Never branched: one implicit take, the same answer the app gives.
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "select_image", "id": id } }),
        )
        .unwrap();
        let out = handle(&state, "takes.list", serde_json::Value::Null).unwrap();
        assert_eq!(out["active"], "take_1");
        assert_eq!(out["takes"][0]["name"], "Take 1");

        // A branched document lists its takes without their graphs:
        // nodes and wires stay on disk, names and notes answer.
        let saved = serde_json::json!({
            "graph_id": "g", "connections": [], "nodes": [],
            "activeVersion": "take_2",
            "versions": [
                { "id": "take_1", "name": "Take 1", "nodes": [], "wires": [] },
                { "id": "take_2", "name": "Cool", "note": "for the client", "nodes": [], "wires": [] }
            ]
        });
        crate::save_graph_file(&tmp.path().join("graphs"), &id, &saved.to_string()).unwrap();
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "select_image", "id": id } }),
        )
        .unwrap();
        let out = handle(&state, "takes.list", serde_json::Value::Null).unwrap();
        assert_eq!(out["active"], "take_2");
        assert_eq!(out["takes"].as_array().unwrap().len(), 2);
        assert_eq!(out["takes"][1]["name"], "Cool");
        assert_eq!(out["takes"][1]["note"], "for the client");
        assert!(out["takes"][1].get("nodes").is_none());
    }

    #[test]
    fn batch_lists_collections_with_counts() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        let cid = state.catalog().unwrap().create_collection("Heroes").unwrap();
        state.catalog().unwrap().add_to_collection(cid, &id).unwrap();
        let out = handle(&state, "catalog.collections", serde_json::Value::Null).unwrap();
        assert_eq!(out[0]["name"], "Heroes");
        assert_eq!(out[0]["count"], 1);
        assert_eq!(out[0]["hasLook"], false);
    }

    #[test]
    fn export_naming_matches_the_panels_rules() {
        // The cases below are the export.test.ts suite's, kept in lock
        // step by hand: the two doors name files from one template
        // language, and a drift here writes a different tree in batch
        // than the panel would.
        assert_eq!(fill_template("{name}", "P1032386.RW2", 0, 1, 0, ""), "P1032386");
        assert_eq!(fill_template("{name}_web", "beach.jpeg", 0, 1, 0, ""), "beach_web");
        assert_eq!(fill_template("{n}", "a.dng", 0, 9, 0, ""), "1");
        assert_eq!(fill_template("{n}", "a.dng", 0, 10, 0, ""), "01");
        assert_eq!(fill_template("{n}", "a.dng", 9, 120, 0, ""), "010");
        assert_eq!(fill_template("{n}", "a.dng", 119, 120, 0, ""), "120");
        assert_eq!(fill_template("{name}-{stars}-{flag}", "a.dng", 0, 1, 4, "pick"), "a-4-pick");
        assert_eq!(fill_template("{flag}", "a.dng", 0, 1, 0, ""), "none");
        // A typo shows up in the name rather than vanishing.
        assert_eq!(fill_template("{name}_{nmae}", "a.dng", 0, 1, 0, ""), "a_{nmae}");

        assert_eq!(sanitize_filename("a<b>c:d\"e/f\\g|h?i*j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(sanitize_filename("beach walk-2"), "beach walk-2");
        assert_eq!(sanitize_filename("shot. "), "shot");
        assert_eq!(sanitize_filename("con"), "_con");
        assert_eq!(sanitize_filename("NUL"), "_NUL");
        assert_eq!(sanitize_filename(""), "untitled");

        let mut taken = std::collections::HashSet::new();
        let d1 = export_destination("D:/out/", "jpg", "{name}", "a.dng", 0, 2, 0, "", &mut taken);
        assert_eq!(d1, PathBuf::from("D:/out/a.jpg"));
        // The RAW+JPEG twin shares the stem; the run disambiguates
        // instead of overwriting.
        let d2 = export_destination("D:/out/", "jpg", "{name}", "a.jpg", 1, 2, 0, "", &mut taken);
        assert_eq!(d2, PathBuf::from("D:/out/a-2.jpg"));
    }

    #[test]
    fn export_run_normalizes_numeric_dpi_like_the_frontend() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        for (i, (dpi, expected)) in [
            (serde_json::Value::Null, 300),
            (serde_json::json!(240), 240),
            (serde_json::json!(0), 1),
            (serde_json::json!(-5), 1),
            (serde_json::json!(240.4), 240),
            (serde_json::json!(240.5), 241),
            (serde_json::json!(1e100), 65535),
        ].into_iter().enumerate() {
            let out = handle(&state, "export.run", serde_json::json!({
                "ids": [id], "dir": tmp.path().join(format!("dpi-{i}")),
                "format": "jpeg", "keepMetadata": false, "dpi": dpi,
            })).unwrap();
            assert_eq!(out["failed"].as_array().unwrap().len(), 0);
            let bytes = std::fs::read(out["written"][0].as_str().unwrap()).unwrap();
            let at = bytes.windows(5).position(|w| w == b"JFIF\0").unwrap();
            assert_eq!(u16::from_be_bytes([bytes[at + 8], bytes[at + 9]]), expected, "case {i}");
        }
    }

    #[test]
    fn export_run_writes_files_and_reports_per_image_failures() {
        let tmp = tempfile::tempdir().unwrap();
        let (state, id) = state_with_one_image(tmp.path());
        let out_dir = tmp.path().join("out");
        let out = handle(
            &state,
            "export.run",
            serde_json::json!({
                "ids": [id, "ghost"],
                "dir": out_dir.to_string_lossy(),
                "format": "jpeg",
                "keepMetadata": false,
            }),
        )
        .unwrap();
        // One failure does not stop the run: the good image lands and
        // the bad id is reported by name.
        assert_eq!(out["written"].as_array().unwrap().len(), 1);
        assert_eq!(out["failed"].as_array().unwrap().len(), 1);
        assert_eq!(out["failed"][0]["name"], "ghost");
        let written = out["written"][0].as_str().unwrap();
        assert!(written.ends_with("one.jpg"), "{written}");
        assert!(std::path::Path::new(written).exists());

        // The open image exports its live, unsaved edits.
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "select_image", "id": id } }),
        )
        .unwrap();
        handle(
            &state,
            "graph.command",
            serde_json::json!({ "command": { "type": "set_param", "id": "src", "param": "camera_wb", "value": 0 } }),
        )
        .unwrap();
        let out = handle(
            &state,
            "export.run",
            serde_json::json!({
                "dir": out_dir.to_string_lossy(),
                "format": "png",
                "template": "{name}-{n}",
                "keepMetadata": false,
            }),
        )
        .unwrap();
        let written = out["written"][0].as_str().unwrap();
        assert!(written.ends_with("one-1.png"), "{written}");

        // A nonsense format refuses by naming the valid ones.
        let err = handle(
            &state,
            "export.run",
            serde_json::json!({ "ids": [id], "dir": out_dir.to_string_lossy(), "format": "gif" }),
        )
        .unwrap_err();
        assert!(err.contains("jpeg"), "{err}");

        // No ids: the open image is the target, the way the panel
        // falls back to the active one.
        let out = handle(
            &state,
            "export.run",
            serde_json::json!({ "dir": out_dir.to_string_lossy(), "keepMetadata": false }),
        )
        .unwrap();
        assert_eq!(out["written"].as_array().unwrap().len(), 1);

        // Nothing open and no ids: refused in words.
        let tmp2 = tempfile::tempdir().unwrap();
        let (fresh, _) = state_with_one_image(tmp2.path());
        let err = handle(
            &fresh,
            "export.run",
            serde_json::json!({ "dir": out_dir.to_string_lossy() }),
        )
        .unwrap_err();
        assert!(err.contains("open_image"), "{err}");
    }
}
