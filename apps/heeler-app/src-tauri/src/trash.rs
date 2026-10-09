//! Move to Trash: the only way a photograph leaves a folder.
//!
//! "I've decided I don't want ANY code that deletes files to
//! exist in this app." So this does not delete. It renames a photograph
//! into a `.trash` folder beside it and writes down where it came from,
//! and Put Back is that rename going the other way. Emptying the trash
//! is the file manager's job, not ours, which is also why the folder is
//! plain and visible rather than hidden: somebody who finds it should be
//! able to understand it and act on it without this app running.
//!
//! `.trash` sits beside the images on purpose. It keeps every move on
//! one volume, so a move is always a rename and never a copy followed by
//! a removal of the source. A central trash folder would have put a file
//! removal back in the codebase the first time somebody trashed a
//! photograph from an external drive.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The folder beside the images, and the file inside it that explains
/// itself to anyone who opens it.
pub const TRASH_DIR: &str = ".trash";
const MANIFEST: &str = "manifest.json";

const NOTE: &str = "Photographs moved here by Heeler. Each entry says where its file came \
                    from; Heeler's Put Back returns it there. Nothing in Heeler empties this \
                    folder: delete it yourself when you are sure.";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TrashEntry {
    /// File name inside `.trash`, which is not always the original one:
    /// two folders can send the same name here on different days.
    pub file: String,
    /// Absolute path the photograph came from and returns to.
    pub original: String,
    pub image_id: String,
    pub trashed_at: i64,
    /// Written down BEFORE the rename and cleared after it: an entry that
    /// promises nothing yet. A crash between the two leaves a pending
    /// entry, and the disk says which half happened: the file in the
    /// trash means the move completed and only the index is behind; the
    /// file still at its original path means the move never started.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pending: bool,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Manifest {
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub items: Vec<TrashEntry>,
}

#[derive(Serialize, Default, Debug)]
pub struct TrashReport {
    pub moved: usize,
    /// The ids that actually moved, so the caller can update exactly
    /// those rows rather than every id it asked about: a count cannot
    /// say WHICH photograph's rename failed.
    #[serde(default)]
    pub moved_ids: Vec<String>,
    /// One line per photograph that stayed where it was, and why. A
    /// partial move is reported rather than rolled back: the ones that
    /// made it are in a folder the user can see.
    pub failed: Vec<String>,
    /// Files moved successfully but their index still needs repair.
    pub index_pending: Vec<String>,
}

/// Catalog reconciliation follows the physical move, including an index error.
pub fn record_outcome(report: &mut TrashReport, id: &str, outcome: Result<MoveOutcome, String>, update_catalog: impl FnOnce() -> Result<(), String>) {
    match outcome {
        Ok(outcome) => {
            if let Err(error) = update_catalog() { report.failed.push(format!("{} moved, but the catalog needs repair: {error}", outcome.path.display())); }
            if let Some(error) = outcome.index_pending { report.index_pending.push(id.to_string()); report.failed.push(error); }
            report.moved += 1; report.moved_ids.push(id.to_string());
        }
        Err(error) => report.failed.push(error),
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The `.trash` beside a photograph, whether or not it exists yet.
pub fn trash_dir_for(image_path: &Path) -> Option<PathBuf> {
    image_path.parent().map(|p| p.join(TRASH_DIR))
}

pub fn manifest_path(trash: &Path) -> PathBuf {
    trash.join(MANIFEST)
}

/// Display-only fallback. Mutations use the checked reader below.
pub fn read_manifest(trash: &Path) -> Manifest {
    read_manifest_checked(trash).unwrap_or_default()
}

fn read_manifest_checked(trash: &Path) -> Result<Manifest, String> {
    let path = manifest_path(trash);
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(m) => Ok(m),
            Err(e) => {
                let kept = heeler_project::atomic::preserve_broken(&path).map_err(|e| e.to_string())?;
                Err(format!("{} needs repair: {e}. Original bytes are preserved at {}", path.display(), kept.display()))
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let interrupted = std::fs::read_dir(trash).into_iter().flatten().flatten().any(|e| {
                let n = e.file_name().to_string_lossy().to_string(); n.starts_with("manifest.json.") && n.ends_with(".broken")
            });
            if interrupted { Err(format!("{} needs repair from its .broken copy", path.display())) }
            else { Ok(Manifest::default()) }
        }
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

#[derive(Debug)]
pub struct MoveOutcome { pub path: PathBuf, pub index_pending: Option<String> }


pub fn write_manifest(trash: &Path, m: &Manifest) -> Result<(), String> {
    let mut m = Manifest { note: NOTE.to_string(), items: m.items.clone() };
    m.items.sort_by(|a, b| a.trashed_at.cmp(&b.trashed_at).then(a.file.cmp(&b.file)));
    let text = serde_json::to_string_pretty(&m).map_err(|e| e.to_string())?;
    heeler_project::atomic::write_json(manifest_path(trash), text).map_err(|e| e.to_string())
}

// No lock file guards the manifest, deliberately.
//
// A review added one, against two trash operations interleaving their
// read-modify-write. The race cannot happen: move_images_to_trash and
// restore_images_from_trash are both sync Tauri commands, so they run
// on the main thread and serialize, and nothing else calls in here. The
// cost of guarding it anyway was a lock file living in a folder we tell
// the user is theirs to open, a stale-lock takeover that could delete a
// live lock held by a slow process, a new user-visible refusal, and
// a file-removal call inside the one module whose whole premise is
// that this app does not delete files.
//
// If concurrency ever does arrive, the fix belongs at the command
// layer: one process-wide mutex held across the whole batch. That costs
// no file, deletes nothing, and covers the multi-id loop as a unit,
// which a per-call file lock does not.

/// A name nothing in `dir` is using yet.
///
/// Trashing "IMG_001.NEF" from a folder that already trashed one last
/// week must not land on top of last week's. Overwriting would destroy a
/// photograph, which is the one thing this module exists to avoid.
pub fn free_name(dir: &Path, file_name: &str) -> String {
    if !dir.join(file_name).exists() {
        return file_name.to_string();
    }
    let path = Path::new(file_name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(file_name);
    let ext = path.extension().and_then(|e| e.to_str());
    for n in 2..10_000 {
        let candidate = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    // Ten thousand collisions on one name is not a case worth a clever
    // answer; the timestamp ends it.
    match ext {
        Some(e) => format!("{stem} ({}).{e}", now_unix()),
        None => format!("{stem} ({})", now_unix()),
    }
}

/// Renames a photograph into the `.trash` beside it and records where it
/// came from. Returns its new path.
///
/// Note: only the one file travels. If Heeler ever writes sidecars
/// (.xmp, .heeledit) beside a negative, they should move with it, a
/// decision to make when sidecars exist, not to stumble into.
pub fn move_to_trash(image_path: &Path, image_id: &str) -> Result<PathBuf, String> {
    move_to_trash_recorded(image_path, image_id).map(|r| r.path)
}

pub fn move_to_trash_recorded(image_path: &Path, image_id: &str) -> Result<MoveOutcome, String> {
    move_with(image_path, image_id, write_manifest)
}
fn move_with(image_path: &Path, image_id: &str, writer: impl FnOnce(&Path, &Manifest) -> Result<(), String>) -> Result<MoveOutcome, String> {
    if !image_path.exists() {
        return Err(format!("{} is not there", image_path.display()));
    }
    let trash = trash_dir_for(image_path)
        .ok_or_else(|| format!("{} has no folder to put a trash beside", image_path.display()))?;
    std::fs::create_dir_all(&trash).map_err(|e| format!("cannot make {}: {e}", trash.display()))?;

    let name = image_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("{} has no file name", image_path.display()))?;
    let file = free_name(&trash, name);
    let target = trash.join(&file);
    // Read before moving. Damage must not be replaced by a one-entry index.
    let before = read_manifest_checked(&trash)?;
    let mut m = Manifest { note: before.note.clone(), items: before.items.clone() };
    // An earlier move of this photograph that was noted but never
    // happened settles now, against the disk.
    settle_pending(&trash, &mut m, image_id);
    // The move is written down first, marked pending, so the index
    // itself is the record that survives a crash between the two
    // steps; no extra file per move is left in the user's folder. An
    // index that cannot take the note stops the move before anything
    // has been touched. Older entries under this id are left as they
    // are until the rename has happened: a note that retired them
    // ahead of a move that then failed, with the index restore failing
    // too, left the older file answering to a retired id for good.
    m.items.push(TrashEntry {
        file: file.clone(),
        original: image_path.to_string_lossy().to_string(),
        image_id: image_id.to_string(),
        trashed_at: now_unix(),
        pending: true,
    });
    write_manifest(&trash, &m)?;
    if let Err(e) = std::fs::rename(image_path, &target) {
        // Nothing moved: put the index back the way it was, and say so
        // if even that fails (the pending entry then reconciles itself
        // on the next read, since its file is not in the trash).
        let restored = write_manifest(&trash, &before);
        return Err(match restored {
            Ok(()) => format!("{}: {e}", image_path.display()),
            Err(w) => format!("{}: {e}. The index still notes the move as pending: {w}", image_path.display()),
        });
    }
    // A re-trashed id already has an entry whose file is still in the
    // folder. The app never deletes, so the old file keeps its place in
    // the index under a retired id: dropping the entry would orphan the
    // file, and neither Put Back nor trash_size would know it was there.
    let done = m.items.len() - 1;
    retire_older(&mut m, image_id, done);
    m.items[done].pending = false;
    let index_pending = writer(&trash, &m).err().map(|e| {
        format!(
            "{} moved to {}. Index update pending: {e}. The index lists the move as pending and Put Back completes it",
            image_path.display(),
            target.display()
        )
    });
    Ok(MoveOutcome { path: target, index_pending })
}

/// Every other entry under `image_id` answers to a retired name from
/// here on, so the live id names exactly one file: the one at `keep`.
fn retire_older(m: &mut Manifest, image_id: &str, keep: usize) {
    let mut n = 1;
    for at in 0..m.items.len() {
        if at == keep || m.items[at].image_id != image_id {
            continue;
        }
        let name = loop {
            let candidate = format!("{image_id}~replaced{n}");
            n += 1;
            if !m.items.iter().any(|j| j.image_id == candidate) {
                break candidate;
            }
        };
        m.items[at].image_id = name;
    }
}

/// Settles the pending entries for one photograph against the disk: a
/// pending entry whose file is in the trash was a completed move whose
/// index write did not land, so it counts; one whose file is not there
/// never moved, so it goes. Neither answer needs a guess. Returns the
/// files of the moves that counted.
fn settle_pending(trash: &Path, m: &mut Manifest, image_id: &str) -> Vec<String> {
    m.items.retain(|i| {
        !(i.pending
            && i.image_id == image_id
            && !(Path::new(&i.file).file_name() == Some(std::ffi::OsStr::new(&i.file))
                && trash.join(&i.file).is_file()))
    });
    let mut settled = Vec::new();
    for i in m.items.iter_mut().filter(|i| i.pending && i.image_id == image_id) {
        i.pending = false;
        settled.push(i.file.clone());
    }
    settled
}

/// Puts a photograph back where it came from.
///
/// `original` is the catalog's own record of the path, which is what the
/// row still says: trashing does not rewrite it, precisely so this can
/// be a rename with no guessing in it.
pub fn restore_from_trash(original: &Path, image_id: &str) -> Result<(), String> {
    restore_recorded(original, image_id).map(|_| ())
}
pub fn restore_recorded(original: &Path, image_id: &str) -> Result<MoveOutcome, String> {
    restore_with(original, image_id, write_manifest)
}
fn restore_with(original: &Path, image_id: &str, writer: impl FnOnce(&Path, &Manifest) -> Result<(), String>) -> Result<MoveOutcome, String> {
    let trash = trash_dir_for(original)
        .ok_or_else(|| format!("{} has no trash beside it", original.display()))?;
    let mut m = read_manifest_checked(&trash)?;
    // A move whose index write did not land is in the index as pending;
    // the disk says whether it happened. That same unfinished move can
    // leave an older entry still live under the id (its retirement rides
    // the write that did not land), so Put Back takes the newest: the
    // later move, or on the same second the one the disk just settled.
    let settled = settle_pending(&trash, &mut m, image_id);
    let (chosen, entry) = m
        .items
        .iter()
        .enumerate()
        .filter(|(_, i)| i.image_id == image_id)
        .max_by_key(|(_, i)| (i.trashed_at, settled.contains(&i.file)))
        .ok_or_else(|| format!("nothing in {} is {image_id}", trash.display()))?;
    // The manifest is editable data, never authority to move a file
    // outside this trash. Accept one native file name only, preserving
    // punctuation that is legal on the user's filesystem.
    if Path::new(&entry.file).file_name() != Some(std::ffi::OsStr::new(&entry.file)) {
        return Err(format!("invalid trash entry file name: {}", manifest_path(&trash).display()));
    }
    let source = trash.join(&entry.file);
    if !source.exists() {
        return Err(format!("{} is no longer in the trash", entry.file));
    }
    if original.exists() {
        // Somebody put a file back by hand, or a new shoot reused the
        // name. Either way this one is not ours to overwrite.
        return Err(format!(
            "{} already exists. Move it aside first, or take the file out of {} yourself.",
            original.display(),
            trash.display()
        ));
    }
    std::fs::rename(&source, original).map_err(|e| {
        format!(
            "{} could not go back to {}: {e}. If the folder it came from is gone, \
             recreate it or take the file out of {} yourself.",
            source.display(),
            original.display(),
            trash.display()
        )
    })?;
    // Any other file still under this id keeps its record under a
    // retired name; only the returned file leaves the index.
    let mut kept = Manifest { note: String::new(), items: m.items.clone() };
    retire_older(&mut kept, image_id, chosen);
    kept.items.remove(chosen);
    let index_pending = writer(&trash, &kept).err().map(|e| format!("{} is back in its folder. Index update pending: {e}", original.display()));
    Ok(MoveOutcome { path: original.to_path_buf(), index_pending })
}

/// Where a trashed photograph's file is: `Ok` with the file the trash
/// index names for it (a collision in `.trash` gives it a numbered
/// name), or its recorded path when it is back there (dragged out by
/// hand, the catalog not yet told). `Err` with where it would be inside
/// `.trash` when it is in neither place: the user removed it outside
/// Heeler, since Heeler deletes nothing (2026-10-01: "If a file in
/// .trash is not found, I think its clear the user removed it").
///
/// Reads the index and never writes it: the checked reader sets a
/// damaged index aside, which a question about where a file is must not
/// do. A damaged index answers as an empty one, and the original name is
/// looked for instead.
pub fn locate_trashed(recorded: &Path, image_id: &str) -> Result<PathBuf, PathBuf> {
    let Some(trash) = trash_dir_for(recorded) else {
        return Ok(recorded.to_path_buf());
    };
    let index = std::fs::read(manifest_path(&trash))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Manifest>(&raw).ok())
        .unwrap_or_default();
    let mut entries = index
        .items
        .iter()
        .filter(|i| i.image_id == image_id && Path::new(&i.file).file_name() == Some(std::ffi::OsStr::new(&i.file)))
        .collect::<Vec<_>>();
    entries.sort_by_key(|i| std::cmp::Reverse(i.trashed_at));
    if let Some(entry) = entries.iter().find(|i| trash.join(&i.file).is_file()) {
        return Ok(trash.join(&entry.file));
    }
    let name = recorded.file_name().unwrap_or_default();
    if entries.is_empty() && trash.join(name).is_file() {
        return Ok(trash.join(name));
    }
    if recorded.is_file() {
        return Ok(recorded.to_path_buf());
    }
    Err(match entries.first() {
        Some(entry) => trash.join(&entry.file),
        None => trash.join(name),
    })
}

/// The root of the removable drive or share a path lives on, as the
/// path itself spells it (never re-joined, so a Windows path keeps its
/// backslashes): a Windows drive (`E:\`) or share (`\\nas\photos\`), or
/// a macOS `/Volumes/<name>`. None for a path on no such drive.
pub fn volume_root(path: &Path) -> Option<&Path> {
    use std::path::Component;
    let parts: Vec<Component> = path.components().take(3).collect();
    let depth = match parts.as_slice() {
        [Component::Prefix(_), Component::RootDir, ..] => 2,
        [Component::RootDir, Component::Normal(top), Component::Normal(_)] if *top == "Volumes" => 3,
        _ => return None,
    };
    path.ancestors().find(|a| a.components().count() == depth)
}

/// Which drives are not there, asked once per drive: a list of hundreds
/// of photographs on one unplugged drive (or an unreachable share, where
/// each question can wait on the network) asks once.
#[derive(Default)]
pub struct VolumeCheck(std::collections::HashMap<PathBuf, bool>);
impl VolumeCheck {
    /// The drive a path lives on when that drive is not there to ask: a
    /// volume root (volume_root) that does not exist or cannot be read.
    /// A photograph there is not known to be gone; it is on a drive that
    /// is unplugged.
    pub fn unmounted(&mut self, path: &Path) -> Option<PathBuf> {
        let root = volume_root(path)?;
        let gone = *self.0.entry(root.to_path_buf()).or_insert_with(|| std::fs::read_dir(root).is_err());
        gone.then(|| root.to_path_buf())
    }
}

/// Trashed photographs whose file is no longer in `.trash`, found for
/// Forget Missing Trashed Photos. Ones on a drive that is not connected
/// are skipped, counted and named, never offered.
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct MissingTrashed {
    pub ids: Vec<String>,
    /// Where each one was last, inside its `.trash`, in `ids` order.
    pub paths: Vec<String>,
    pub skipped: usize,
    pub skipped_volumes: Vec<String>,
}

/// Sorts trashed rows (id, recorded path) into the ones whose file is
/// gone and the ones on a drive that is not there; the rest have their
/// file and are left alone. Reads only.
pub fn missing_trashed(rows: &[(String, String)]) -> MissingTrashed {
    let mut out = MissingTrashed::default();
    let mut volumes = std::collections::BTreeSet::new();
    let mut check = VolumeCheck::default();
    for (id, path) in rows {
        let recorded = Path::new(path);
        if let Some(volume) = check.unmounted(recorded) {
            out.skipped += 1;
            volumes.insert(volume.to_string_lossy().into_owned());
            continue;
        }
        if let Err(gone) = locate_trashed(recorded, id) {
            out.ids.push(id.clone());
            out.paths.push(gone.to_string_lossy().into_owned());
        }
    }
    out.skipped_volumes = volumes.into_iter().collect();
    out
}

/// What a folder's trash is holding: how many photographs, and how much
/// disk they are sitting on.
///
/// The number behind the discovery story. A trash nobody can see the
/// size of is a trash nobody empties.
pub fn trash_size(trash: &Path) -> (usize, u64) {
    // Counted from the disk, not the index: a pending entry whose move
    // never happened, or a file the user took out by hand, is not
    // something the trash is holding.
    let m = read_manifest(trash);
    let present: Vec<u64> = m
        .items
        .iter()
        .filter_map(|i| std::fs::metadata(trash.join(&i.file)).ok())
        .map(|md| md.len())
        .collect();
    (present.len(), present.iter().sum())
}

/// For tests: the root of a drive that is not plugged in, in this
/// platform's own form. On Windows a drive letter nothing answers on
/// (`Q:\`); elsewhere a `/Volumes` name nobody mounts.
#[cfg(test)]
pub(crate) fn unplugged_root() -> PathBuf {
    if cfg!(windows) {
        ('D'..='Z')
            .rev()
            .map(|letter| PathBuf::from(format!("{letter}:\\")))
            .find(|root| std::fs::read_dir(root).is_err())
            .expect("a drive letter with no drive behind it")
    } else {
        PathBuf::from(format!("/Volumes/heeler-test-unmounted-{}", std::process::id()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The drive is read from the path as written: a Windows drive or
    /// share, or a macOS volume; anywhere else, no drive at all.
    #[test]
    fn a_volume_root_is_spelled_as_its_path_spells_it() {
        assert_eq!(volume_root(Path::new("/Volumes/Card/DCIM/P1.RW2")), Some(Path::new("/Volumes/Card")));
        assert_eq!(volume_root(Path::new("/Volumes/Card")), Some(Path::new("/Volumes/Card")));
        assert_eq!(volume_root(Path::new("/Volumes")), None);
        assert_eq!(volume_root(Path::new("/Users/user/P1.RW2")), None);
        assert_eq!(volume_root(Path::new("relative/P1.RW2")), None);
        if cfg!(windows) {
            assert_eq!(volume_root(Path::new(r"E:\DCIM\P1.RW2")).map(|p| p.as_os_str().to_owned()), Some(r"E:\".into()));
            assert_eq!(volume_root(Path::new(r"\\nas\photos\2026\P1.RW2")).map(|p| p.as_os_str().to_owned()), Some(r"\\nas\photos\".into()));
        }
        let root = unplugged_root();
        let mut check = VolumeCheck::default();
        let photo = root.join("shoot").join("P1.RW2");
        assert_eq!(check.unmounted(&photo), Some(root.clone()));
        assert_eq!(check.unmounted(&root.join("P2.RW2")), Some(root));
        // The drive the temporary folder is on is there.
        let here = tempfile::tempdir().unwrap();
        assert_eq!(check.unmounted(&here.path().join("P3.RW2")), None);
    }

    #[test]
    fn moved_file_with_failed_index_is_listed_pending_and_can_be_put_back() {
        let d = folder(); let original = d.path().join("IMG_001.NEF");
        let result = move_with(&original, "a", |_, _| Err("disk full".into())).unwrap();
        assert!(!original.exists()); assert!(result.path.exists());
        assert!(result.index_pending.unwrap().contains("disk full"));
        // The index itself carries the record: one pending entry, no
        // extra file in the folder beside the photograph and the index.
        let trash = d.path().join(TRASH_DIR);
        let m = read_manifest(&trash);
        assert_eq!(m.items.len(), 1);
        assert!(m.items[0].pending);
        let files: Vec<String> = std::fs::read_dir(&trash).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
        assert!(files.iter().all(|f| !f.contains("move")), "{files:?}");
        restore_from_trash(&original, "a").unwrap();
        assert_eq!(std::fs::read(original).unwrap(), b"a negative");
        assert!(read_manifest(&trash).items.is_empty());
    }
    #[test]
    fn a_pending_entry_whose_move_never_happened_settles_itself() {
        let d = folder(); let original = d.path().join("IMG_001.NEF"); let trash = d.path().join(TRASH_DIR);
        std::fs::create_dir(&trash).unwrap();
        // A crash between the pending note and the rename: the entry is
        // in the index, the photograph is still in its folder.
        write_manifest(&trash, &Manifest { note: String::new(), items: vec![TrashEntry {
            file: "IMG_001.NEF".into(), original: original.display().to_string(), image_id: "a".into(), trashed_at: 0, pending: true,
        }] }).unwrap();
        assert!(restore_from_trash(&original, "a").unwrap_err().contains("nothing in"));
        assert_eq!(std::fs::read(&original).unwrap(), b"a negative");
        // And the next move of the same photograph goes through cleanly.
        move_to_trash(&original, "a").unwrap();
        let m = read_manifest(&trash);
        assert_eq!(m.items.iter().filter(|i| i.image_id == "a").count(), 1);
        assert!(!m.items.iter().any(|i| i.pending));
    }
    #[test]
    fn put_back_reports_file_returned_even_if_index_write_is_denied() {
        let d = folder(); let original = d.path().join("IMG_001.NEF"); move_to_trash(&original, "a").unwrap();
        let result = restore_with(&original, "a", |_, _| Err("permission denied".into())).unwrap();
        assert!(result.path.exists()); assert!(result.index_pending.unwrap().contains("permission denied"));
        assert_eq!(std::fs::read(original).unwrap(), b"a negative");
    }
    #[test]
    fn a_broken_index_blocks_new_moves_and_preserves_original_bytes() {
        let d = folder(); let original = d.path().join("IMG_001.NEF"); let trash = d.path().join(TRASH_DIR);
        std::fs::create_dir(&trash).unwrap(); std::fs::write(manifest_path(&trash), b"{broken").unwrap();
        assert!(move_to_trash(&original, "a").unwrap_err().contains("needs repair"));
        assert!(original.exists()); assert_eq!(std::fs::read(manifest_path(&trash)).unwrap(), b"{broken");
        assert!(std::fs::read_dir(&trash).unwrap().any(|e| e.unwrap().path().to_string_lossy().ends_with(".broken")));
    }
    #[test]
    fn an_unreadable_index_does_not_move_the_photograph() {
        let d = folder(); let original = d.path().join("IMG_001.NEF"); let trash = d.path().join(TRASH_DIR);
        std::fs::create_dir_all(manifest_path(&trash)).unwrap();
        assert!(move_to_trash(&original, "a").is_err()); assert!(original.exists());
    }

    #[test]
    fn index_failure_still_reconciles_the_catalog_as_moved() {
        let d = folder(); let original = d.path().join("IMG_001.NEF");
        let c = heeler_catalog::Catalog::open_in_memory().unwrap();
        let mut paths = std::collections::HashMap::new();
        crate::scan_folder(d.path(), &c, &mut paths, &mut crate::ScanStats::default()).unwrap();
        let id = c.image_id_by_path(&original).unwrap().unwrap();
        let outcome = move_with(&original, &id, |_, _| Err("disk full".into()));
        let mut report = TrashReport::default();
        record_outcome(&mut report, &id, outcome, || c.set_trashed(&id, true).map_err(|e| e.to_string()));
        assert_eq!(report.moved_ids, vec![id.clone()]); assert_eq!(report.index_pending, vec![id.clone()]);
        assert_eq!(c.list_trashed(None).unwrap().len(), 1); assert!(!original.exists());
    }
    #[test]
    fn two_stacks_in_one_folder_leave_in_one_batch() {
        // ("I can only send one stacked photo at a time"): the loop
        // move_images_to_trash runs, over two recipes beside their frames, so a
        // backend that stopped after the first would show here. It does not;
        // the fault was the Mac's Control-click.
        let d = folder();
        let stacks = [d.path().join("MAX_a-b.stack"), d.path().join("MEDIAN_a-b.stack")];
        for s in &stacks { std::fs::write(s, b"{\"frames\":[]}").unwrap(); }
        let c = heeler_catalog::Catalog::open_in_memory().unwrap();
        let mut paths = std::collections::HashMap::new();
        crate::scan_folder(d.path(), &c, &mut paths, &mut crate::ScanStats::default()).unwrap();
        let ids: Vec<String> = stacks.iter().map(|s| c.image_id_by_path(s).unwrap().expect("a stack is cataloged")).collect();
        let mut report = TrashReport::default();
        for id in &ids {
            let path = std::path::PathBuf::from(c.image(id).unwrap().path);
            record_outcome(&mut report, id, move_to_trash_recorded(&path, id), || c.set_trashed(id, true).map_err(|e| e.to_string()));
        }
        assert_eq!(report.moved_ids, ids); assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(stacks.iter().all(|s| !s.exists()));
        let m = read_manifest(&d.path().join(TRASH_DIR));
        assert_eq!(m.items.len(), 2); assert!(m.items.iter().all(|i| !i.pending));
        assert_eq!(c.list_trashed(None).unwrap().len(), 2);
    }
    #[test]
    fn retrash_with_failed_index_puts_back_the_newer_file_and_keeps_the_older() {
        let d = folder(); let original = d.path().join("IMG_001.NEF");
        let first = move_to_trash(&original, "a").unwrap(); std::fs::write(&original, b"new photo").unwrap();
        let second = move_with(&original, "a", |_, _| Err("full".into())).unwrap();
        // The index write that would have retired the older entry did
        // not land, so both answer to "a" until Put Back reads the disk:
        // the newer file comes back, the older keeps its record.
        restore_from_trash(&original, "a").unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), b"new photo");
        assert!(!second.path.exists());
        assert_eq!(std::fs::read(first).unwrap(), b"a negative");
        let m = read_manifest(&d.path().join(TRASH_DIR));
        assert_eq!(m.items.len(), 1);
        assert!(m.items[0].image_id.starts_with("a~replaced"));
    }

    #[test]
    fn a_move_that_failed_twice_over_leaves_the_older_entry_answering_to_its_id() {
        // The rename failed AND the index could not be put back: the
        // index on disk notes a pending move whose file never arrived,
        // beside the entry of an earlier trash of the same id. That
        // earlier entry must still answer to the id.
        let d = folder(); let original = d.path().join("IMG_001.NEF"); let trash = d.path().join(TRASH_DIR);
        let first = move_to_trash(&original, "a").unwrap();
        let mut m = read_manifest(&trash);
        m.items.push(TrashEntry { file: "IMG_001 (2).NEF".into(), original: original.display().to_string(), image_id: "a".into(), trashed_at: now_unix() + 60, pending: true });
        write_manifest(&trash, &m).unwrap();
        let (count, bytes) = trash_size(&trash);
        assert_eq!((count, bytes), (1, 10), "a move that never happened is not held by the trash");
        restore_from_trash(&original, "a").unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), b"a negative");
        assert!(!first.exists());
        assert!(read_manifest(&trash).items.is_empty());
    }

    #[test]
    fn put_back_returns_the_newest_and_keeps_the_older_record_under_a_retired_id() {
        // Both entries live under "a" (the retiring write did not land)
        // and both files are in the trash: the newer goes back, the
        // older is neither returned nor dropped from the index.
        let d = folder(); let original = d.path().join("IMG_001.NEF"); let trash = d.path().join(TRASH_DIR);
        let first = move_to_trash(&original, "a").unwrap();
        std::fs::write(&original, b"new photo").unwrap();
        let second = move_with(&original, "a", |_, _| Err("full".into())).unwrap();
        let m = read_manifest(&trash);
        assert_eq!(m.items.iter().filter(|i| i.image_id == "a").count(), 2);
        restore_from_trash(&original, "a").unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), b"new photo");
        assert!(!second.path.exists());
        assert!(first.exists());
        let m = read_manifest(&trash);
        assert_eq!(m.items.len(), 1);
        assert!(m.items[0].image_id.starts_with("a~replaced"));
        assert_eq!(trash.join(&m.items[0].file), first);
    }

    fn folder() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("IMG_001.NEF"), b"a negative").unwrap();
        d
    }

    #[test]
    fn a_manifest_cannot_move_a_file_from_outside_the_trash() {
        let d = folder();
        let trash = d.path().join(TRASH_DIR);
        std::fs::create_dir_all(&trash).unwrap();
        let original = d.path().join("restored.NEF");
        let outside = d.path().join("IMG_001.NEF");
        let mut invalid = vec!["../IMG_001.NEF", outside.to_str().unwrap(), ".", "..", "", "nested/photo.NEF"];
        if cfg!(windows) {
            invalid.extend(["..\\IMG_001.NEF", "C:photo.NEF"]);
        }
        for file in invalid {
            write_manifest(&trash, &Manifest {
                note: String::new(),
                items: vec![TrashEntry {
                    file: file.to_string(), original: original.display().to_string(),
                    image_id: "test".to_string(), trashed_at: 0, pending: false,
                }],
            }).unwrap();
            let error = restore_from_trash(&original, "test").unwrap_err();
            assert!(error.starts_with("invalid trash entry file name:"), "{error}");
            assert!(error.ends_with(manifest_path(&trash).to_str().unwrap()));
            assert_eq!(std::fs::read(&outside).unwrap(), b"a negative");
            assert!(!original.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn legal_native_filename_punctuation_still_round_trips() {
        let d = tempfile::tempdir().unwrap();
        let original = d.path().join("photo:one\\two.NEF");
        std::fs::write(&original, b"a negative").unwrap();
        move_to_trash(&original, "punctuation").unwrap();
        restore_from_trash(&original, "punctuation").unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), b"a negative");
    }

    #[test]
    fn trashing_moves_the_file_and_puts_it_back_byte_for_byte() {
        let d = folder();
        let original = d.path().join("IMG_001.NEF");

        let moved = move_to_trash(&original, "img_abc").unwrap();
        assert!(!original.exists(), "the photograph is still in the folder");
        assert!(moved.exists(), "the photograph did not arrive in the trash");
        assert_eq!(moved.parent().unwrap().file_name().unwrap(), TRASH_DIR);
        assert_eq!(std::fs::read(&moved).unwrap(), b"a negative");

        restore_from_trash(&original, "img_abc").unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), b"a negative");
        assert!(!moved.exists());
        // The manifest let go of it, so a second Put Back has nothing to
        // say rather than half-doing something.
        assert!(restore_from_trash(&original, "img_abc").is_err());
    }

    #[test]
    fn the_manifest_says_where_every_file_came_from() {
        let d = folder();
        let original = d.path().join("IMG_001.NEF");
        move_to_trash(&original, "img_abc").unwrap();

        let m = read_manifest(&d.path().join(TRASH_DIR));
        assert_eq!(m.items.len(), 1);
        assert_eq!(m.items[0].image_id, "img_abc");
        assert_eq!(m.items[0].original, original.to_string_lossy());
        assert!(m.note.contains("Put Back"), "the folder does not explain itself: {:?}", m.note);
    }

    #[test]
    fn a_name_that_was_trashed_before_does_not_land_on_the_old_one() {
        // Two shoots, a month apart, both with an IMG_001.NEF. The
        // second must not overwrite the first: that would be this app
        // destroying a photograph, by accident, in the code written to
        // stop it destroying photographs.
        let d = folder();
        let original = d.path().join("IMG_001.NEF");
        move_to_trash(&original, "img_one").unwrap();
        std::fs::write(&original, b"a different negative").unwrap();
        let second = move_to_trash(&original, "img_two").unwrap();

        let trash = d.path().join(TRASH_DIR);
        assert_ne!(second.file_name().unwrap(), "IMG_001.NEF");
        assert_eq!(std::fs::read(trash.join("IMG_001.NEF")).unwrap(), b"a negative");
        assert_eq!(std::fs::read(&second).unwrap(), b"a different negative");
        assert_eq!(read_manifest(&trash).items.len(), 2);
        let (count, bytes) = trash_size(&trash);
        assert_eq!(count, 2);
        assert_eq!(bytes, 10 + 20);
    }

    #[test]
    fn put_back_refuses_rather_than_overwrite_something_that_returned_first() {
        let d = folder();
        let original = d.path().join("IMG_001.NEF");
        move_to_trash(&original, "img_abc").unwrap();
        std::fs::write(&original, b"put back by hand").unwrap();

        let err = restore_from_trash(&original, "img_abc").unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(std::fs::read(&original).unwrap(), b"put back by hand");
        // And the trashed copy is still there to be dealt with, not lost
        // between the two.
        assert_eq!(read_manifest(&d.path().join(TRASH_DIR)).items.len(), 1);
    }

    #[test]
    fn a_manifest_somebody_broke_does_not_strand_the_photographs() {
        let d = folder();
        let original = d.path().join("IMG_001.NEF");
        let moved = move_to_trash(&original, "img_abc").unwrap();
        let trash = d.path().join(TRASH_DIR);
        std::fs::write(manifest_path(&trash), b"{ not json").unwrap();

        // Reading is survivable: an empty index over files that are
        // still sitting right there, named as the user named them.
        assert!(read_manifest(&trash).items.is_empty());
        assert!(moved.exists());
        assert!(restore_from_trash(&original, "img_abc").is_err());
    }

    #[test]
    fn re_trashing_an_id_retires_the_old_entry_rather_than_orphaning_its_file() {
        let d = folder();
        let original = d.path().join("IMG_001.NEF");
        let first = move_to_trash(&original, "img_abc").unwrap();
        // No Put Back in between: a new shoot reused the name and the
        // same catalog row gets trashed a second time.
        std::fs::write(&original, b"a different negative").unwrap();
        let second = move_to_trash(&original, "img_abc").unwrap();

        let trash = d.path().join(TRASH_DIR);
        let m = read_manifest(&trash);
        assert_eq!(m.items.len(), 2, "the old file keeps its place in the index");
        assert!(first.exists(), "the app never deletes: the first copy stays");
        assert!(second.exists());
        // The live id names the new entry; the old one answers to a
        // retired id, so Put Back cannot confuse the two.
        assert!(m.items.iter().any(|i| i.image_id == "img_abc" && i.file == second.file_name().unwrap().to_string_lossy()));
        assert!(m.items.iter().any(|i| i.image_id.starts_with("img_abc~replaced")));
        let (count, _) = trash_size(&trash);
        assert_eq!(count, 2, "both copies count toward the size");
    }

    #[test]
    fn put_back_with_the_folder_gone_says_so_plainly() {
        let d = folder();
        let original = d.path().join("IMG_001.NEF");
        move_to_trash(&original, "img_abc").unwrap();
        // The folder the photograph came from was renamed while it was
        // trashed, so the catalog's recorded path leads nowhere: the
        // refusal must read as an explanation, not an OS error.
        let moved_parent = d.path().join("renamed folder");
        let err = restore_from_trash(&moved_parent.join("IMG_001.NEF"), "img_abc").unwrap_err();
        assert!(err.contains("nothing in"), "{err}");
        // And the photograph is still exactly where the trash put it.
        assert!(d.path().join(TRASH_DIR).join("IMG_001.NEF").exists());
    }

    /// Every file under `dir` with its size, for "nothing was touched".
    fn listing(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            out.push(format!("{} {}", p.display(), std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0)));
            if p.is_dir() {
                out.extend(listing(&p));
            }
        }
        out.sort();
        out
    }

    /// Forget Missing Trashed Photos offers exactly the trashed photographs
    /// whose file left `.trash` (2026-10-01: "yes, build the purge"): one
    /// still in the trash, one put back, and one on a drive that is not
    /// connected are not offered, and finding them touches no file.
    #[test]
    fn missing_trashed_offers_only_files_gone_from_the_trash_and_skips_unplugged_drives() {
        let d = tempfile::tempdir().unwrap();
        let shoot = d.path().join("TEST");
        std::fs::create_dir(&shoot).unwrap();
        for name in ["gone.dng", "kept.dng", "back.dng"] {
            std::fs::write(shoot.join(name), name.as_bytes()).unwrap();
            move_to_trash(&shoot.join(name), name).unwrap();
        }
        restore_from_trash(&shoot.join("back.dng"), "back.dng").unwrap();
        // Emptied by hand outside Heeler: moved out of the tree, so the
        // test removes nothing either.
        let away = tempfile::tempdir().unwrap();
        std::fs::rename(shoot.join(TRASH_DIR).join("gone.dng"), away.path().join("gone.dng")).unwrap();
        let unplugged_path = unplugged_root();
        let unplugged = unplugged_path.to_string_lossy().into_owned();
        let row = |id: &str, path: PathBuf| (id.to_string(), path.to_string_lossy().into_owned());
        let rows = vec![
            row("gone.dng", shoot.join("gone.dng")),
            row("kept.dng", shoot.join("kept.dng")),
            row("back.dng", shoot.join("back.dng")),
            row("far.dng", unplugged_path.join("shoot").join("far.dng")),
        ];
        let before = listing(d.path());
        let found = missing_trashed(&rows);
        assert_eq!(listing(d.path()), before, "finding them touched a file");
        assert_eq!(found.ids, vec!["gone.dng"]);
        assert_eq!(found.paths, vec![shoot.join(TRASH_DIR).join("gone.dng").to_string_lossy().into_owned()]);
        assert_eq!(found.skipped, 1);
        assert_eq!(found.skipped_volumes, vec![unplugged]);

        // And on a catalog: what the command does with its answer.
        let data = tempfile::tempdir().unwrap();
        let catalog = heeler_catalog::Catalog::open(&data.path().join("catalog.sqlite")).unwrap();
        for (id, path) in &rows {
            catalog.add_image(id, Path::new(path), None).unwrap();
            if id != "back.dng" {
                catalog.set_trashed(id, true).unwrap();
            }
        }
        let trashed = catalog
            .list_trashed(None)
            .unwrap()
            .into_iter()
            .map(|r| (r.id, r.path))
            .collect::<Vec<_>>();
        let gone = missing_trashed(&trashed).ids;
        assert_eq!(catalog.forget_trashed_images(&gone).unwrap(), 1);
        assert!(catalog.image("gone.dng").is_err());
        for kept in ["kept.dng", "back.dng", "far.dng"] {
            assert_eq!(catalog.image(kept).unwrap().id, kept);
        }
        assert_eq!(listing(d.path()), before, "forgetting touched a file");
    }

    /// The trash index's own name for a file is the one looked for: a
    /// collision renamed it, and the original name in `.trash` is a
    /// different photograph.
    #[test]
    fn locate_trashed_reads_the_name_the_index_gave() {
        let d = folder();
        let trash = d.path().join(TRASH_DIR);
        std::fs::create_dir(&trash).unwrap();
        std::fs::write(trash.join("IMG_001.NEF"), b"last week").unwrap();
        let moved = move_to_trash(&d.path().join("IMG_001.NEF"), "a").unwrap();
        assert_eq!(locate_trashed(&d.path().join("IMG_001.NEF"), "a"), Ok(moved.clone()));
        let away = tempfile::tempdir().unwrap();
        std::fs::rename(&moved, away.path().join("x")).unwrap();
        assert_eq!(locate_trashed(&d.path().join("IMG_001.NEF"), "a"), Err(moved));
    }
}
