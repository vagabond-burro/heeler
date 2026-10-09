//! Preferences > Models > Check for model updates, and the apply
//! behind it (2026-09-09: "being able to check for an update
//! models would be nice").
//!
//! The rule is the app update's: one fixed URL, a manifest that rides
//! the GitHub release beside the installers, never api.github.com.
//! `models.json` lists, per model id, the version the LLC has vetted
//! and the pins to fetch it by. The app compares the versions of the
//! models it has installed and offers the newer ones; applying one
//! downloads through the same staged, hashed, verified path the
//! registry's own pins use, and leaves an install record so the newer
//! weights count as installed. Upstream "latest" is never followed:
//! an entry appears in the manifest only after its weights have been
//! run through the tests.

use serde::Serialize;

use heeler_vision::{ArchiveKind, ExtraSource, ModelSource};

pub const MANIFEST_URL: &str = "https://github.com/vagabond-burro/heeler/releases/latest/download/models.json";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUpdate {
    pub id: String,
    pub label: String,
    /// The version in place, as people read it ("2026.06").
    pub installed: String,
    /// The manifest's, the same way.
    pub latest: String,
    /// Everything the update would fetch.
    pub bytes: u64,
    pub notes: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUpdatesCheck {
    /// The installed models the manifest carries a newer version of.
    pub updates: Vec<ModelUpdate>,
    /// How many installed models were compared.
    pub checked: usize,
}

/// "YYYY.MM" (or "YYYY.MM.N") as numbers, so 2026.10 sorts after 2026.9.
pub(crate) fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().split('.');
    let y = parts.next()?.parse().ok()?;
    let m = parts.next()?.parse().ok()?;
    let n = match parts.next() {
        Some(p) => p.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((y, m, n))
}

/// What the manifest says against what is installed. Pure: the
/// rules live in tests rather than behind a network call. `installed`
/// is (id, label, installed version) for every model in place.
pub(crate) fn assess(manifest: &str, installed: &[(String, String, String)]) -> Result<ModelUpdatesCheck, String> {
    let doc: serde_json::Value = serde_json::from_str(manifest).map_err(|_| "the model list could not be read".to_string())?;
    if doc.get("schema").and_then(|v| v.as_u64()) != Some(1) {
        return Err("the model list is written for a newer Heeler".into());
    }
    let models = doc.get("models").and_then(|m| m.as_object()).ok_or("the model list names no models")?;
    let mut updates = Vec::new();
    for (id, label, have) in installed {
        let Some(entry) = models.get(id) else { continue };
        let Some(latest) = entry.get("version").and_then(|v| v.as_str()) else { continue };
        let (Some(newer), Some(mine)) = (parse_version(latest), parse_version(have)) else { continue };
        if newer <= mine {
            continue;
        }
        let bytes = entry.get("extra").and_then(|e| e.as_array()).into_iter().flatten()
            .try_fold(entry.get("archive_bytes").and_then(|v| v.as_u64()).unwrap_or(0), |sum, x| {
                sum.checked_add(x.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0))
            }).ok_or("the model download size is too large")?;
        updates.push(ModelUpdate {
            id: id.clone(),
            label: label.clone(),
            installed: have.clone(),
            latest: latest.to_string(),
            bytes,
            notes: entry.get("notes").and_then(|n| n.as_str()).unwrap_or("").trim().to_string(),
        });
    }
    Ok(ModelUpdatesCheck { updates, checked: installed.len() })
}

fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// One model's source as the manifest gives it, checked before a byte
/// is fetched: https sources only, sixty-four hex characters for
/// every pin, a name for every file, a size for every download.
pub(crate) fn source_from_manifest(manifest: &str, id: &str) -> Result<ModelSource, String> {
    let doc: serde_json::Value = serde_json::from_str(manifest).map_err(|_| "the model list could not be read".to_string())?;
    if doc.get("schema").and_then(|v| v.as_u64()) != Some(1) {
        return Err("the model list is written for a newer Heeler".into());
    }
    let entry = doc
        .get("models")
        .and_then(|m| m.get(id))
        .ok_or_else(|| format!("the model list carries no entry for {id}"))?;
    let bad = |what: &str| format!("the model list's entry for {id} is not usable: {what}");
    let version = entry.get("version").and_then(|v| v.as_str()).filter(|v| parse_version(v).is_some()).ok_or_else(|| bad("version"))?;
    let urls: Vec<String> = entry
        .get("urls")
        .and_then(|u| u.as_array())
        .map(|u| u.iter().filter_map(|x| x.as_str()).filter(|x| x.starts_with("https://")).map(str::to_string).collect())
        .unwrap_or_default();
    if urls.is_empty() {
        return Err(bad("no https source"));
    }
    let archive_sha256 = entry.get("archive_sha256").and_then(|v| v.as_str()).filter(|v| hex64(v)).ok_or_else(|| bad("archive hash"))?;
    let archive_bytes = entry.get("archive_bytes").and_then(|v| v.as_u64()).filter(|b| *b > 0).ok_or_else(|| bad("archive size"))?;
    let kind = match entry.get("kind").and_then(|v| v.as_str()).unwrap_or("file") {
        "zip" => ArchiveKind::Zip,
        "file" => ArchiveKind::File,
        _ => return Err(bad("kind")),
    };
    let files = entry.get("files").and_then(|f| f.as_array()).ok_or_else(|| bad("files"))?
        .iter().map(|pair| {
            let pair = pair.as_array().filter(|p| p.len() == 2).ok_or_else(|| bad("files"))?;
            let name = pair[0].as_str().ok_or_else(|| bad("file name"))?;
            let sha = pair[1].as_str().ok_or_else(|| bad("file hash"))?;
            Ok((name.to_string(), sha.to_string()))
        }).collect::<Result<Vec<_>, String>>()?;
    let mut extra = Vec::new();
    for x in entry.get("extra").and_then(|e| e.as_array()).map(|e| e.as_slice()).unwrap_or(&[]) {
        let name = x.get("name").and_then(|v| v.as_str()).filter(|n| !n.is_empty() && !n.contains('/') && !n.contains("..")).ok_or_else(|| bad("extra file name"))?;
        let urls: Vec<String> = x
            .get("urls")
            .and_then(|u| u.as_array())
            .map(|u| u.iter().filter_map(|v| v.as_str()).filter(|v| v.starts_with("https://")).map(str::to_string).collect())
            .unwrap_or_default();
        if urls.is_empty() {
            return Err(bad("extra file source"));
        }
        let sha256 = x.get("sha256").and_then(|v| v.as_str()).filter(|v| hex64(v)).ok_or_else(|| bad("extra file hash"))?;
        let bytes = x.get("bytes").and_then(|v| v.as_u64()).filter(|b| *b > 0).ok_or_else(|| bad("extra file size"))?;
        extra.push(ExtraSource { name: name.to_string(), urls, sha256: sha256.to_string(), bytes });
    }
    let source = ModelSource {
        id: id.to_string(),
        version: version.to_string(),
        urls,
        archive_sha256: archive_sha256.to_string(),
        archive_bytes,
        kind,
        files,
        extra,
    };
    source.validate().map_err(|e| bad(&e.to_string()))?;
    let spec = crate::RELOCATABLE_MODELS.iter().find(|s| s.id == id).ok_or_else(|| bad("unknown model"))?;
    if source.files.len() != spec.files.len() || !spec.files.iter().all(|(name, _)| source.files.iter().any(|(n, _)| n == name)) {
        return Err(bad("files must retain the names this model loads"));
    }
    Ok(source)
}

/// The manifest the registry itself would publish: every model at its
/// pinned version. What the published manifest carries, and the
/// starting point for the next one; printed by the ignored test below
/// and otherwise unused by the running app.
#[allow(dead_code)]
pub(crate) fn manifest_from_registry(specs: &[&heeler_vision::ModelSpec]) -> String {
    let mut models = serde_json::Map::new();
    for spec in specs {
        let src = ModelSource::from(*spec);
        let mut entry = serde_json::Map::new();
        entry.insert("version".into(), serde_json::json!(src.version));
        entry.insert("label".into(), serde_json::json!(spec.label));
        entry.insert("notes".into(), serde_json::json!(""));
        entry.insert("kind".into(), serde_json::json!(match src.kind { ArchiveKind::Zip => "zip", ArchiveKind::File => "file" }));
        entry.insert("urls".into(), serde_json::json!(src.urls));
        entry.insert("archive_sha256".into(), serde_json::json!(src.archive_sha256));
        entry.insert("archive_bytes".into(), serde_json::json!(src.archive_bytes));
        entry.insert("files".into(), serde_json::json!(src.files));
        if !src.extra.is_empty() {
            entry.insert("extra".into(), serde_json::json!(src.extra));
        }
        models.insert(src.id.clone(), serde_json::Value::Object(entry));
    }
    let doc = serde_json::json!({ "schema": 1, "models": models });
    serde_json::to_string_pretty(&doc).unwrap_or_default()
}

fn fetch_manifest() -> Result<String, String> {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build();
    agent
        .get(MANIFEST_URL)
        .call()
        .map_err(|e| match e {
            // The release feed answers 404 until a release carries
            // models.json at all: not a fault, just not published yet.
            ureq::Error::Status(404, _) => "no model list is published yet: the next release will carry one".to_string(),
            ureq::Error::Status(code, _) => format!("could not reach the model list: HTTP {code}"),
            ureq::Error::Transport(t) => format!("could not reach the model list: {t}"),
        })?
        .into_string()
        .map_err(|e| format!("could not reach the model list: {e}"))
}

/// Reads the model list and says which installed models it carries a
/// newer version of. Err in words the pane can show when the list
/// cannot be reached or read; before the first release the URL is a
/// 404, which is an Err too.
#[tauri::command]
pub async fn model_updates_check(app: tauri::AppHandle) -> Result<ModelUpdatesCheck, String> {
    let base = crate::vision_base(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let installed: Vec<(String, String, String)> = crate::RELOCATABLE_MODELS
            .iter()
            .filter_map(|spec| heeler_vision::installed_version(&base, spec).map(|v| (spec.id.to_string(), spec.label.to_string(), v)))
            .collect();
        assess(&fetch_manifest()?, &installed)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downloads the manifest's version of one model, over the one in
/// place. The loaded sessions drop first, the way a removal drops
/// them, so nothing keeps serving from files being replaced.
#[tauri::command]
pub async fn model_update_apply(app: tauri::AppHandle, model: String) -> Result<(), String> {
    if !crate::RELOCATABLE_MODELS.iter().any(|spec| spec.id == model) {
        return Err(format!("{model} is not a model this Heeler knows"));
    }
    let base = crate::vision_base(&app)?;
    crate::drop_model_sessions(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let source = source_from_manifest(&fetch_manifest()?, &model)?;
        heeler_vision::download_source(&base, &source, |_, _| {}).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_manifest_rejects_every_invalid_file_instead_of_dropping_it() {
        for name in ["../escape", "..\\escape", "C:\\escape", "\\escape", "installed.json", "archive.zip"] {
            let mut doc: serde_json::Value = serde_json::from_str(&manifest("2026.09")).unwrap();
            doc["models"]["scunet_color_real_psnr"]["files"].as_array_mut().unwrap().push(serde_json::json!([name, "a".repeat(64)]));
            assert!(source_from_manifest(&doc.to_string(), "scunet_color_real_psnr").is_err(), "file {name}");
        }
    }

    fn installed() -> Vec<(String, String, String)> {
        vec![
            ("depth_anything_v2_small".into(), "Depth Anything V2 Small (scene depth)".into(), "2024.06".into()),
            ("scunet_color_real_psnr".into(), "SCUNet (noise reduction)".into(), "2026.06".into()),
        ]
    }

    fn manifest(scunet_version: &str) -> String {
        format!(
            r#"{{ "schema": 1, "models": {{
              "scunet_color_real_psnr": {{ "version": "{scunet_version}", "notes": " Re-export with opset 18. ", "kind": "file",
                "urls": ["https://example.com/scunet_color_real_psnr.onnx"], "archive_sha256": "{a}", "archive_bytes": 100,
                "files": [["scunet_color_real_psnr.onnx", "{a}"], ["scunet_color_real_psnr.onnx.data", "{b}"]],
                "extra": [{{ "name": "scunet_color_real_psnr.onnx.data", "urls": ["https://example.com/scunet_color_real_psnr.onnx.data"], "sha256": "{b}", "bytes": 900 }}] }},
              "depth_anything_v2_small": {{ "version": "2024.06", "kind": "file", "urls": ["https://example.com/d.onnx"], "archive_sha256": "{a}", "archive_bytes": 5, "files": [["model.onnx", "{a}"]] }},
              "lama": {{ "version": "2030.01", "kind": "file", "urls": ["https://example.com/l.onnx"], "archive_sha256": "{a}", "archive_bytes": 5, "files": [["lama.onnx", "{a}"]] }}
            }} }}"#,
            a = "a".repeat(64),
            b = "b".repeat(64)
        )
    }

    #[test]
    fn a_newer_version_of_an_installed_model_is_offered_with_its_whole_size() {
        let r = assess(&manifest("2026.09"), &installed()).unwrap();
        assert_eq!(r.checked, 2);
        assert_eq!(r.updates.len(), 1);
        let u = &r.updates[0];
        assert_eq!(u.id, "scunet_color_real_psnr");
        assert_eq!((u.installed.as_str(), u.latest.as_str()), ("2026.06", "2026.09"));
        assert_eq!(u.bytes, 1000);
        assert_eq!(u.notes, "Re-export with opset 18.");
    }

    #[test]
    fn the_same_or_an_older_version_reads_as_current_and_uninstalled_models_are_not_offered() {
        assert!(assess(&manifest("2026.06"), &installed()).unwrap().updates.is_empty());
        assert!(assess(&manifest("2025.12"), &installed()).unwrap().updates.is_empty());
        // LaMa is newer in the list but not installed: no offer.
        assert!(assess(&manifest("2026.06"), &installed()).unwrap().updates.iter().all(|u| u.id != "lama"));
    }

    #[test]
    fn versions_compare_as_numbers() {
        assert!(parse_version("2026.10") > parse_version("2026.9"));
        assert_eq!(parse_version("2026.06"), Some((2026, 6, 0)));
        assert_eq!(parse_version("2026.06.2"), Some((2026, 6, 2)));
        assert_eq!(parse_version("soon"), None);
        assert_eq!(parse_version("2026"), None);
    }

    #[test]
    fn an_unreadable_or_newer_list_is_an_error_in_words() {
        assert_eq!(assess("<html>", &installed()).unwrap_err(), "the model list could not be read");
        assert_eq!(assess(r#"{ "schema": 2, "models": {} }"#, &installed()).unwrap_err(), "the model list is written for a newer Heeler");
        assert_eq!(assess(r#"{ "schema": 1 }"#, &installed()).unwrap_err(), "the model list names no models");
    }

    #[test]
    fn a_manifest_entry_becomes_a_source_only_when_every_pin_is_sound() {
        let src = source_from_manifest(&manifest("2026.09"), "scunet_color_real_psnr").unwrap();
        assert_eq!(src.version, "2026.09");
        assert_eq!(src.kind, ArchiveKind::File);
        assert_eq!(src.files.len(), 2);
        assert_eq!(src.extra.len(), 1);
        assert_eq!(src.total_bytes(), 1000);
        // Only https sources are followed; a short hash is refused; an
        // unknown id is refused.
        let http = manifest("2026.09").replace("https://example.com/scunet_color_real_psnr.onnx\"", "http://example.com/scunet_color_real_psnr.onnx\"");
        assert!(source_from_manifest(&http, "scunet_color_real_psnr").unwrap_err().contains("no https source"));
        let short = manifest("2026.09").replace(&"a".repeat(64), "abc");
        assert!(source_from_manifest(&short, "scunet_color_real_psnr").is_err());
        assert!(source_from_manifest(&manifest("2026.09"), "nope").unwrap_err().contains("no entry"));
    }

    #[test]
    fn the_registrys_own_manifest_reads_as_current_and_round_trips() {
        let text = manifest_from_registry(&crate::RELOCATABLE_MODELS);
        let installed: Vec<(String, String, String)> =
            crate::RELOCATABLE_MODELS.iter().map(|s| (s.id.to_string(), s.label.to_string(), s.version.to_string())).collect();
        let r = assess(&text, &installed).unwrap();
        assert_eq!(r.checked, crate::RELOCATABLE_MODELS.len());
        assert!(r.updates.is_empty(), "the registry cannot be behind itself");
        for spec in crate::RELOCATABLE_MODELS {
            let src = source_from_manifest(&text, spec.id).unwrap();
            assert_eq!(src, ModelSource::from(spec), "{}", spec.id);
        }
    }

    #[test]
    fn the_manifest_url_is_the_release_redirect_and_never_the_api() {
        assert!(MANIFEST_URL.starts_with("https://github.com/vagabond-burro/heeler/releases/latest/download/"));
        assert!(!MANIFEST_URL.contains("api.github.com"));
    }

    /// Prints the registry's manifest: `cargo test -p heeler-app
    /// print_models_manifest -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn print_models_manifest() {
        println!("{}", manifest_from_registry(&crate::RELOCATABLE_MODELS));
    }
}
