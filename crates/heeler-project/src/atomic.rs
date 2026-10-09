//! Durable JSON replacement. Interrupted temporary files remain available for
//! inspection; neither recovery nor a successful retry removes them.
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub fn unique_neighbor(path: &Path, suffix: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(
        "{}.{}-{}-{}.{}",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        stamp,
        NEXT.fetch_add(1, Ordering::Relaxed),
        suffix
    ))
}

fn named(path: &Path, error: io::Error) -> io::Error {
    io::Error::new(error.kind(), format!("{}: {error}", path.display()))
}

pub fn write_json(path: impl AsRef<Path>, data: impl AsRef<[u8]>) -> io::Result<()> {
    let path = path.as_ref();
    // Retain the previous complete document beside every durable JSON file.
    // Backup writes use the primitive directly, so snapshots do not recurse.
    match fs::read(path) {
        Ok(old) if serde_json::from_slice::<serde_json::Value>(&old).is_ok() => {
            let backup = path.with_file_name(format!(
                "{}.good",
                path.file_name().unwrap_or_default().to_string_lossy()
            ));
            write_with(&backup, &old, |file, bytes| {
                file.write_all(bytes)?;
                file.sync_all()
            })?;
        }
        Ok(_) => {
            preserve_broken(path)?;
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(named(path, e)),
    }
    write_with(path, data.as_ref(), |file, bytes| {
        file.write_all(bytes)?;
        file.sync_all()
    })
}

/// The injected operation covers partial writes, full disks and denied flushes.
/// The destination is untouched until all bytes have been synchronized.
pub fn write_with(
    path: &Path,
    data: &[u8],
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> io::Result<()> {
    serde_json::from_slice::<serde_json::Value>(data)
        .map_err(|e| named(path, io::Error::new(io::ErrorKind::InvalidData, e)))?;
    let temp = unique_neighbor(path, "tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| named(path, e))?;
    write(&mut file, data).map_err(|e| named(path, e))?;
    drop(file);
    fs::rename(&temp, path).map_err(|e| named(path, e))?;
    // Unix needs the containing directory synchronized for rename durability.
    #[cfg(unix)]
    File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
    .and_then(|dir| dir.sync_all())
    .map_err(|e| named(path, e))?;
    Ok(())
}

/// Keep damaged bytes under a unique, recognizable name, then restore a copy
/// at the original path. A crash between these operations leaves the .broken
/// file as an explicit recovery marker; it never authorizes a fresh save.
pub fn preserve_broken(path: &Path) -> io::Result<PathBuf> {
    // The same damage preserved twice is one more file to explain. Every
    // look at a damaged file preserves it (the loader, then the writer
    // that replaces it), so a .broken neighbor already holding these
    // exact bytes is the record, and is what gets named.
    if let Some(existing) = identical_broken(path)? {
        return Ok(existing);
    }
    let broken = unique_neighbor(path, "broken");
    fs::rename(path, &broken).map_err(|e| named(path, e))?;
    fs::copy(&broken, path).map_err(|e| named(&broken, e))?;
    sync_file(path).map_err(|e| named(path, e))?;
    Ok(broken)
}

/// Flush a file that is already on disk under its final name.
///
/// Windows refuses FlushFileBuffers on a handle opened without write
/// access (error 5, access denied), so a read-only open followed by
/// sync_all works on macOS and fails on every Windows machine. The file
/// is opened for writing here, without truncation, and flushed through
/// that handle. Where the file itself is read-only, Unix can still flush
/// through a read handle; Windows cannot, and the error says so rather
/// than pretending the bytes are safe.
pub fn sync_file(path: &Path) -> io::Result<()> {
    let file = match OpenOptions::new().write(true).open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied && cfg!(unix) => File::open(path)?,
        Err(e) => return Err(e),
    };
    file.sync_all()
}

fn identical_broken(path: &Path) -> io::Result<Option<PathBuf>> {
    let bytes = fs::read(path).map_err(|e| named(path, e))?;
    let prefix = format!("{}.", path.file_name().unwrap_or_default().to_string_lossy());
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    for entry in fs::read_dir(parent).map_err(|e| named(parent, e))?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(&prefix) && name.ends_with(".broken") && fs::read(entry.path()).ok().as_deref() == Some(&bytes[..]) {
            return Ok(Some(entry.path()));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_damage_is_preserved_once_and_different_damage_again() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("graph.json");
        fs::write(&p, b"{broken").unwrap();
        let first = preserve_broken(&p).unwrap();
        assert_eq!(preserve_broken(&p).unwrap(), first, "the existing record is named again");
        assert_eq!(fs::read(&p).unwrap(), b"{broken", "the damaged file stays in place");
        // The writer that replaces a damaged file preserves through the
        // same door, so a load followed by a save leaves one copy.
        write_json(&p, b"{\"take\":1}").unwrap();
        let broken = || fs::read_dir(d.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".broken")).count();
        assert_eq!(broken(), 1);
        fs::write(&p, b"{broken differently").unwrap();
        assert_ne!(preserve_broken(&p).unwrap(), first);
        assert_eq!(broken(), 2);
    }
    #[test]
    fn a_written_file_flushes_on_every_platform_and_a_missing_one_says_so() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("graph.json");
        fs::write(&p, b"{}").unwrap();
        sync_file(&p).unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"{}", "flushing never truncates");
        assert_eq!(
            sync_file(&d.path().join("absent.json")).unwrap_err().kind(),
            io::ErrorKind::NotFound
        );
    }
    #[test]
    fn failures_keep_old_bytes_and_partial_temp_for_recovery() {
        for kind in [io::ErrorKind::StorageFull, io::ErrorKind::PermissionDenied] {
            let d = tempfile::tempdir().unwrap();
            let p = d.path().join("graph.json");
            write_json(&p, b"{\"take\":1}").unwrap();
            let e = write_with(&p, b"{\"take\":2}", |f, _| {
                f.write_all(b"{")?;
                Err(io::Error::from(kind))
            })
            .unwrap_err();
            assert!(e.to_string().contains("graph.json"));
            assert_eq!(fs::read(&p).unwrap(), b"{\"take\":1}");
            assert_eq!(fs::read_dir(d.path()).unwrap().count(), 2);
            write_json(&p, b"{\"take\":3}").unwrap();
            assert_eq!(fs::read(&p).unwrap(), b"{\"take\":3}");
        }
    }
    #[test]
    fn invalid_json_and_rename_failure_leave_destination_untouched() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("project.json");
        write_json(&p, b"{}").unwrap();
        assert!(write_json(&p, b"{").is_err());
        assert_eq!(fs::read(&p).unwrap(), b"{}");
        let directory = d.path().join("directory.json");
        fs::create_dir(&directory).unwrap();
        assert!(write_with(&directory, b"{}", |file, bytes| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .unwrap_err()
        .to_string()
        .contains("directory.json"));
        assert!(directory.is_dir());
    }
    #[test]
    fn concurrent_writers_use_distinct_temporary_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("graph.json");
        std::thread::scope(|scope| {
            for n in 0..20 {
                let p = &p;
                scope.spawn(move || write_json(p, format!("{{\"n\":{n}}}")).unwrap());
            }
        });
        assert!(serde_json::from_slice::<serde_json::Value>(&fs::read(p).unwrap()).is_ok());
        assert!(fs::read_dir(d.path()).unwrap().all(|e| !e
            .unwrap()
            .path()
            .to_string_lossy()
            .ends_with(".tmp")));
    }
    #[test]
    fn broken_preservation_keeps_each_damage_exactly_once_under_its_own_name() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("graph.json");
        fs::write(&p, b"{broken\xff").unwrap();
        let a = preserve_broken(&p).unwrap();
        assert_eq!(preserve_broken(&p).unwrap(), a, "the same bytes name the record already kept");
        fs::write(&p, b"{broken\xfe").unwrap();
        let b = preserve_broken(&p).unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read(a).unwrap(), b"{broken\xff");
        assert_eq!(fs::read(&b).unwrap(), b"{broken\xfe");
        assert_eq!(fs::read(b).unwrap(), fs::read(&p).unwrap());
    }
}
