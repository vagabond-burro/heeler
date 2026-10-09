//! Graph recovery and revision admission share a process-wide gate. The gate is
//! held through the atomic rename, so an older IPC cannot finish after a newer one.
use heeler_project::atomic::{preserve_broken, write_json};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[derive(Serialize, Debug)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum GraphLoad {
    /// No edits to load. `revision` is the gate's floor all the same: a
    /// reset marker (or the legacy demo edit) carries the revision that
    /// archived it, and the next edit has to start above it even on a
    /// machine whose clock is behind the one that wrote it.
    Absent {
        revision: u64,
        #[serde(rename = "lineWidth", skip_serializing_if = "Option::is_none")]
        line_width: Option<f64>,
    },
    Ready {
        data: String,
    },
    Blocked {
        path: String,
        error: String,
        broken: Option<String>,
        last_good: bool,
    },
}
static REVISIONS: OnceLock<Mutex<HashMap<PathBuf, u64>>> = OnceLock::new();
fn gate() -> &'static Mutex<HashMap<PathBuf, u64>> {
    REVISIONS.get_or_init(Default::default)
}
/// Hold revision admission while recovery copies graph and take documents.
pub fn snapshot<T>(read: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _guard = gate().lock().map_err(|_| "graph lock poisoned")?;
    read()
}

fn path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{}.json", crate::sanitize_id(id)))
}
/// An id that names no photograph would read and write a bare `.json`
/// beside every graph: refused at the door rather than trusted to the
/// frontend's own guards.
fn named(id: &str) -> Result<(), String> {
    if crate::sanitize_id(id).is_empty() {
        return Err("No photograph is open, so there are no edits to read or save.".into());
    }
    Ok(())
}
fn good(p: &Path) -> PathBuf {
    p.with_extension("json.good")
}
fn valid(data: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    let graph = |g: &serde_json::Value| {
        g.get("nodes")
            .and_then(|v| v.as_array())
            .is_some_and(|nodes| {
                nodes.iter().all(|n| {
                    n.get("id").is_some_and(|v| v.is_string())
                        && n.get("type").is_some_and(|v| v.is_string())
                        && n.get("params").is_some_and(|v| v.is_object())
                })
            })
            && g.get("wires")
                .and_then(|v| v.as_array())
                .is_some_and(|wires| {
                    wires.iter().all(|w| {
                        w.get("from").is_some_and(|v| v.is_string())
                            && w.get("to").is_some_and(|v| v.is_string())
                    })
                })
    };
    graph(&v)
        && v.get("versions").is_none_or(|versions| {
            versions.as_array().is_some_and(|vs| {
                vs.iter()
                    .all(|g| graph(g) && g.get("id").is_some_and(|id| id.is_string()))
            })
        })
}
fn broken_files(p: &Path) -> Vec<PathBuf> {
    let prefix = format!("{}.", p.file_name().unwrap_or_default().to_string_lossy());
    std::fs::read_dir(p.parent().unwrap())
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy();
            n.starts_with(&prefix) && n.ends_with(".broken")
        })
        .collect()
}
fn inspect(p: &Path) -> GraphLoad {
    let error = match std::fs::read_to_string(p) {
        Ok(data) if valid(&data) => {
            if serde_json::from_str::<serde_json::Value>(&data)
                .ok()
                .is_some_and(|v| v.get("heelerReset").and_then(|v| v.as_bool()) == Some(true))
            {
                return GraphLoad::Absent { revision: revision(&data), line_width: serde_json::from_str::<serde_json::Value>(&data).ok().and_then(|v| v.get("lineWidth").and_then(|w| w.as_f64())) };
            }
            return GraphLoad::Ready { data };
        }
        Ok(_) => "The saved edits are not a valid graph.".to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && broken_files(p).is_empty() => {
            return GraphLoad::Absent { revision: 0, line_width: None }
        }
        Err(e) => format!("Cannot read the saved edits: {e}"),
    };
    let existing = broken_files(p).into_iter().find(|b| {
        std::fs::read(b)
            .ok()
            .zip(std::fs::read(p).ok())
            .is_some_and(|(a, b)| a == b)
    });
    let (broken, error) = match existing {
        Some(b) => (Some(b), error),
        None if p.is_file() => match preserve_broken(p) {
            Ok(b) => (Some(b), error),
            Err(e) => (None, format!("{error} Preservation failed: {e}")),
        },
        None => (broken_files(p).into_iter().next(), error),
    };
    GraphLoad::Blocked {
        path: p.display().to_string(),
        error,
        broken: broken.map(|b| b.display().to_string()),
        last_good: std::fs::read_to_string(good(p)).is_ok_and(|d| valid(&d)),
    }
}
pub fn load(dir: &Path, id: &str) -> Result<GraphLoad, String> {
    named(id)?;
    let _lock = gate().lock().map_err(|e| e.to_string())?;
    Ok(inspect(&path(dir, id)))
}
pub fn revision(data: &str) -> u64 {
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .and_then(|v| v.get("revision").and_then(|v| v.as_u64()))
        .unwrap_or(0)
}
pub fn save(dir: &Path, id: &str, data: &str, rev: u64, resolve: bool) -> Result<(), String> {
    save_with(dir, id, data, rev, resolve, |p, d| {
        write_json(p, d).map_err(|e| e.to_string())
    })
}
fn save_with(
    dir: &Path,
    id: &str,
    data: &str,
    rev: u64,
    resolve: bool,
    writer: impl FnOnce(&Path, &str) -> Result<(), String>,
) -> Result<(), String> {
    named(id)?;
    let p = path(dir, id);
    let mut revisions = gate().lock().map_err(|e| e.to_string())?;
    if !valid(data) {
        return Err(format!("{}: invalid graph payload", p.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let previous = inspect(&p);
    let disk_revision = std::fs::read_to_string(&p)
        .map(|data| revision(&data))
        .unwrap_or(0);
    let latest = revisions.entry(p.clone()).or_default();
    *latest = (*latest).max(disk_revision);
    if rev < *latest {
        return Err(format!(
            "{}: revision {rev} is older than {}",
            p.display(),
            *latest
        ));
    }
    // Admission survives a failed write: retrying an older revision cannot replace it.
    *latest = rev;
    match previous {
        GraphLoad::Blocked { error, .. } if !resolve => {
            return Err(format!("{}: recovery required. {error}", p.display()))
        }
        GraphLoad::Blocked { broken, .. } => {
            // inspect has already preserved the damage, or found the
            // identical .broken copy from an earlier look; preserving
            // again here left a duplicate per repeated recovery. Only a
            // preservation that failed there is tried again.
            if broken.is_none() && p.exists() {
                preserve_broken(&p).map_err(|e| e.to_string())?;
            }
        }
        GraphLoad::Ready { .. } => {}
        GraphLoad::Absent { .. } => {}
    }
    let mut payload: serde_json::Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
    payload["revision"] = rev.into();
    if let Ok(old) = std::fs::read_to_string(&p) {
        if serde_json::from_str::<serde_json::Value>(&old)
            .ok()
            .as_ref()
            == Some(&payload)
        {
            return Ok(());
        }
    }
    writer(&p, &payload.to_string()).map_err(|e| format!("{}: {e}", p.display()))
}
/// Reset archives the edit instead of removing it and participates in revision
/// admission, so a delayed save from before Reset cannot bring the edit back.
/// The archived document comes back to the caller (None when there were no
/// saved edits), read under the same gate as the rename, so Undo can write
/// back exactly what the reset put away (Reset Edits had no undo).
pub fn reset(dir: &Path, id: &str, rev: u64) -> Result<Option<String>, String> {
    named(id)?;
    let p = path(dir, id);
    let mut revisions = gate().lock().map_err(|e| e.to_string())?;
    let loaded = inspect(&p);
    if let GraphLoad::Blocked { error, .. } = &loaded {
        return Err(format!(
            "{}: recovery required before resetting. {error}",
            p.display()
        ));
    }
    let disk_revision = std::fs::read_to_string(&p)
        .map(|data| revision(&data))
        .unwrap_or(0);
    let latest = revisions.entry(p.clone()).or_default();
    *latest = (*latest).max(disk_revision);
    if rev < *latest {
        return Err(format!(
            "{}: reset revision {rev} is older than {}",
            p.display(),
            *latest
        ));
    }
    *latest = rev;
    let line_width = match &loaded {
        GraphLoad::Ready { data } => serde_json::from_str::<serde_json::Value>(data).ok().and_then(|v| v.get("lineWidth").cloned()),
        GraphLoad::Absent { line_width, .. } => line_width.map(|w| serde_json::json!(w)),
        _ => None,
    };
    let archived = match loaded {
        GraphLoad::Ready { data } => {
            let kept = heeler_project::atomic::unique_neighbor(&p, "reset");
            std::fs::rename(&p, &kept).map_err(|e| format!("{}: {e}", p.display()))?;
            Some(data)
        }
        _ => None,
    };
    let mut marker = serde_json::json!({ "nodes": [], "wires": [], "heelerReset": true, "revision": rev });
    // Thickness belongs to the photograph, so resetting edits keeps it
    // even when this photograph has never been opened in this session.
    if let Some(width) = line_width { marker["lineWidth"] = width; }
    write_json(&p, marker.to_string())
    .map_err(|e| e.to_string())?;
    Ok(archived)
}

pub fn last_good(dir: &Path, id: &str) -> Result<String, String> {
    named(id)?;
    let p = good(&path(dir, id));
    let data = std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    if !valid(&data) {
        return Err(format!("{}: last saved copy is invalid", p.display()));
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = r#"{"nodes":[],"wires":[],"activeVersion":"take_1"}"#;
    #[test]
    fn the_empty_id_reads_and_writes_nothing() {
        let d = tempfile::tempdir().unwrap();
        // The stray file an old empty-id autosave could leave behind.
        std::fs::write(d.path().join(".json"), A).unwrap();
        std::fs::write(d.path().join(".json.good"), A).unwrap();
        assert!(load(d.path(), "").is_err());
        assert!(last_good(d.path(), "").is_err());
        assert!(save(d.path(), "", A, 9, false).is_err());
        assert!(reset(d.path(), "", 9).is_err());
        assert_eq!(std::fs::read_to_string(d.path().join(".json")).unwrap(), A, "the stray file is left as it was");
        let names: Vec<_> = std::fs::read_dir(d.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 2, "nothing written beside it: {names:?}");
    }
    #[test]
    fn reset_archives_edits_rejects_older_saves_and_refuses_damaged_files() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), "a", A, 1, false).unwrap();
        // The archived document comes back for Undo.
        let archived = reset(d.path(), "a", 3).unwrap().expect("the saved edits come back");
        assert!(archived.contains("take_1"));
        assert_eq!(revision(&archived), 1);
        // A photograph with no saved edits has nothing archived.
        assert_eq!(reset(d.path(), "never", 1).unwrap(), None);
        // Absent, and the marker's revision rides along as the floor.
        assert!(matches!(load(d.path(), "a").unwrap(), GraphLoad::Absent { revision: 3, .. }));
        assert!(save(d.path(), "a", A, 2, false).is_err());
        let kept = std::fs::read_dir(d.path())
            .unwrap()
            .flatten()
            .find(|e| e.path().extension().is_some_and(|e| e == "reset"))
            .unwrap();
        assert!(std::fs::read_to_string(kept.path())
            .unwrap()
            .contains("take_1"));
        std::fs::write(path(d.path(), "a"), b"broken").unwrap();
        assert!(reset(d.path(), "a", 4)
            .unwrap_err()
            .contains("recovery required"));
        assert_eq!(std::fs::read(path(d.path(), "a")).unwrap(), b"broken");
    }
    #[test]
    fn missing_invalid_and_unreadable_are_distinct_and_block_writes() {
        let d = tempfile::tempdir().unwrap();
        assert!(matches!(load(d.path(), "a").unwrap(), GraphLoad::Absent { revision: 0, line_width: None }));
        let p = path(d.path(), "a");
        std::fs::write(&p, b"{broken\xff").unwrap();
        assert!(matches!(
            load(d.path(), "a").unwrap(),
            GraphLoad::Blocked {
                broken: Some(_),
                ..
            }
        ));
        assert_eq!(std::fs::read(&p).unwrap(), b"{broken\xff");
        assert!(save(d.path(), "a", A, 1, false).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), b"{broken\xff");
        let p2 = path(d.path(), "b");
        std::fs::create_dir(&p2).unwrap();
        assert!(matches!(
            load(d.path(), "b").unwrap(),
            GraphLoad::Blocked { .. }
        ));
    }
    #[test]
    fn interrupted_preservation_is_not_a_new_photograph() {
        let d = tempfile::tempdir().unwrap();
        let p = path(d.path(), "a");
        std::fs::write(heeler_project::atomic::unique_neighbor(&p, "broken"), b"{").unwrap();
        assert!(matches!(
            load(d.path(), "a").unwrap(),
            GraphLoad::Blocked { .. }
        ));
        assert!(save(d.path(), "a", A, 1, false).is_err());
    }
    #[test]
    fn failed_newer_revision_rejects_old_retry_and_keeps_last_good() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), "a", A, 1, false).unwrap();
        let b = A.replace("take_1", "take_2");
        for reason in ["disk full", "permission denied"] {
            let e = save_with(d.path(), "a", &b, 3, false, |_, _| Err(reason.into())).unwrap_err();
            assert!(e.contains("a.json") && e.contains(reason));
            assert!(save(d.path(), "a", A, 2, false).is_err());
        }
        save(d.path(), "a", &b, 3, false).unwrap();
        assert!(std::fs::read_to_string(path(d.path(), "a"))
            .unwrap()
            .contains("take_2"));
        assert!(last_good(d.path(), "a").unwrap().contains("take_1"));
    }
    #[test]
    fn explicit_recovery_preserves_damage_and_restores_the_last_good_take() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), "a", A, 1, false).unwrap();
        save(d.path(), "a", &A.replace("take_1", "take_2"), 2, false).unwrap();
        std::fs::write(path(d.path(), "a"), b"broken").unwrap();
        let recovered = last_good(d.path(), "a").unwrap();
        save(d.path(), "a", &recovered, 3, true).unwrap();
        assert!(
            matches!(load(d.path(), "a").unwrap(), GraphLoad::Ready { data } if data.contains("take_1"))
        );
        assert!(broken_files(&path(d.path(), "a"))
            .iter()
            .any(|p| std::fs::read(p).unwrap() == b"broken"));
        // One copy of the damage, not one per look at it.
        assert_eq!(broken_files(&path(d.path(), "a")).len(), 1);
        // The same damage again preserves nothing new; different damage does.
        std::fs::write(path(d.path(), "a"), b"broken").unwrap();
        save(d.path(), "a", &recovered, 4, true).unwrap();
        assert_eq!(broken_files(&path(d.path(), "a")).len(), 1);
        std::fs::write(path(d.path(), "a"), b"broken differently").unwrap();
        save(d.path(), "a", &recovered, 5, true).unwrap();
        assert_eq!(broken_files(&path(d.path(), "a")).len(), 2);
    }
    #[test]
    fn review_26_4_reset_keeps_photo_thickness_across_repeated_resets() {
        let d = tempfile::tempdir().unwrap();
        let mut doc: serde_json::Value = serde_json::from_str(A).unwrap();
        doc["lineWidth"] = serde_json::json!(6);
        save(d.path(), "width", &doc.to_string(), 1, false).unwrap();
        for rev in [2, 3] {
            reset(d.path(), "width", rev).unwrap();
            let result = serde_json::to_value(load(d.path(), "width").unwrap()).unwrap();
            assert_eq!(result["status"], "absent");
            assert_eq!(result["lineWidth"].as_f64(), Some(6.0));
            assert_eq!(result["revision"], rev);
        }
    }

}
