//! On-disk proxies for images that are expensive to produce.
//!
//! Most photographs are decoded once and cached in memory, and that is
//! enough: a second decode costs a fraction of a second. Stacks and
//! panoramas are not like that. Their "decode" is a merge or a whole
//! stitch, taking seconds to tens of seconds, and the in-memory cache
//! holds only a handful of images. Cull through a folder and come back
//! to your panorama and it stitches again from nothing, which is what a
//! lagging viewport actually is.
//!
//! So the result goes to disk, keyed by everything that could change it.
//! This is the same idea as a catalog editor's smart previews: pay the
//! expensive render once, then navigate against the cheap copy.
//!
//! The format is a raw dump rather than PNG or TIFF, for two reasons.
//! Heeler works in scene-linear f32 and a merged HDR runs well past 1.0,
//! so an 8-bit encode would clip exactly the highlights the merge
//! recovered. And the point of the cache is speed: a memcpy off disk
//! beats a decode, and there is no compression pass in the way.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use heeler_engine::buffers::ImageBuf;

/// Magic and version. A cache with a different layout must be ignored
/// rather than reinterpreted: the numbers would be silently wrong.
const MAGIC: &[u8; 8] = b"HEELPRX1";
/// How much disk the cache may use before the oldest proxies are
/// dropped.
///
/// A budget in bytes rather than a count of files, because the files are
/// not remotely the same size. A panorama preview is around 36 MB; a
/// full-resolution stack of 45 megapixel frames is around 720 MB. Twenty
/// four of those would have been 17 GB of someone's disk, quietly, which
/// is not a cache, it is a leak with a lid on it.
const BUDGET: u64 = 4 << 30; // 4 GiB

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// Identity of a rendered proxy.
///
/// Everything that could change the pixels goes in: the recipe itself,
/// every member's size and modification time, and whatever the caller
/// adds for the tier and develop options. Miss one and the user gets a
/// stale panorama with no way to tell it is stale, which is far worse
/// than the wait.
pub fn key_for(manifest: &Path, members: &[String], extra: &str) -> String {
    let mut sig = heeler_io::input_color::identity(Ok(None));
    if let Ok(text) = std::fs::read_to_string(manifest) {
        sig.push_str(&text);
    }
    let folder = manifest.parent().unwrap_or(Path::new("."));
    for m in members {
        sig.push('|');
        sig.push_str(m);
        sig.push_str(&heeler_io::input_color::file_identity(&folder.join(m)));
        if let Ok(meta) = std::fs::metadata(folder.join(m)) {
            sig.push_str(&format!(":{}", meta.len()));
            if let Ok(t) = meta.modified() {
                if let Ok(d) = t.duration_since(std::time::UNIX_EPOCH) {
                    // Milliseconds: a member re-written within the same
                    // whole second at the same length (an in-place touch
                    // by another tool, a fast re-export) must not key
                    // identically to the proxy it invalidates.
                    sig.push_str(&format!(":{}", d.as_millis()));
                }
            }
        } else {
            // A member that is gone changes the result, so it has to
            // change the key.
            sig.push_str(":missing");
        }
    }
    sig.push('|');
    sig.push_str(extra);
    format!("{:016x}", fnv1a(sig.as_bytes()))
}

fn path_for(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{key}.hprx"))
}

/// Full-tier dimensions for denoise cache discovery, without loading pixels.
pub fn dimensions(dir: &Path, key: &str) -> Option<(usize, usize)> {
    let mut file = std::fs::File::open(path_for(dir, key)).ok()?;
    let mut head = [0u8; 16];
    file.read_exact(&mut head).ok()?;
    if &head[..8] != MAGIC { return None; }
    let w = u32::from_le_bytes(head[8..12].try_into().ok()?) as usize;
    let h = u32::from_le_bytes(head[12..16].try_into().ok()?) as usize;
    let bytes = w.checked_mul(h)?.checked_mul(16)?.checked_add(16)?;
    (w > 0 && h > 0 && file.metadata().ok()?.len() == bytes as u64).then_some((w, h))
}

/// Reads a proxy, or None if it is absent or unreadable. Never an error:
/// a broken cache entry is a cache miss, and the caller renders instead.
pub fn load(dir: &Path, key: &str) -> Option<ImageBuf> {
    load_checked(dir, key).ok().flatten()
}

/// A damaged cache is a miss; memory refusal must reach the caller instead
/// of triggering an even more expensive merge or stitch.
pub fn load_checked(dir: &Path, key: &str) -> Result<Option<ImageBuf>, String> {
    load_admitted(&path_for(dir, key)).map_err(|e| format!("{e}: {}", path_for(dir, key).display()))
}

fn load_admitted(path: &Path) -> Result<Option<ImageBuf>, heeler_engine::memory::MemoryError> {
    use heeler_engine::memory::{self, Job};
    let Ok(mut file) = std::fs::File::open(path) else { return Ok(None); };
    let mut head = [0u8; 16];
    if file.read_exact(&mut head).is_err() || &head[..8] != MAGIC { return Ok(None); }
    let width = u32::from_le_bytes(head[8..12].try_into().unwrap()) as usize;
    let height = u32::from_le_bytes(head[12..16].try_into().unwrap()) as usize;
    if width == 0 || height == 0 { return Ok(None); }
    let byte_count = memory::bytes(width, height, 4, 4)?;
    if file.metadata().ok().map(|m| m.len()) != (byte_count as u64).checked_add(16) { return Ok(None); }
    let _job = Job::admit(memory::sum([byte_count, 64 * 1024])?, "proxy pixels and read buffer")?;
    let mut img = ImageBuf::try_new(width, height)?;
    let mut file = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut bytes = [0u8; 4];
    for sample in &mut img.data {
        if file.read_exact(&mut bytes).is_err() { return Ok(None); }
        *sample = f32::from_le_bytes(bytes);
    }
    Ok(Some(img))
}

/// Writes a proxy. Best effort: a cache that cannot be written is a
/// slower app, not a broken one, so nothing here is reported upward.
pub fn store(dir: &Path, key: &str, img: &ImageBuf) {
    if u32::try_from(img.width).is_err() || u32::try_from(img.height).is_err()
        || heeler_engine::memory::bytes(img.width, img.height, 4, 4).ok() != img.data.len().checked_mul(4) { return; }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    // Write to a temporary name and rename into place, so a crash or a
    // second window mid-write cannot leave a half file that later reads
    // as a valid header with missing pixels.
    let tmp = dir.join(format!("{key}.partial"));
    let ok = (|| -> std::io::Result<()> {
        let mut file = std::io::BufWriter::with_capacity(64 * 1024, std::fs::File::create(&tmp)?);
        file.write_all(MAGIC)?;
        file.write_all(&(img.width as u32).to_le_bytes())?;
        file.write_all(&(img.height as u32).to_le_bytes())?;
        for v in &img.data { file.write_all(&v.to_le_bytes())?; }
        file.flush()?;
        file.get_ref().sync_all()
    })()
    .is_ok();
    if ok {
        let _ = std::fs::rename(&tmp, path_for(dir, key));
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
    prune(dir, BUDGET);
}

/// Drops the oldest proxies until the cache fits in `budget` bytes.
///
/// The newest is always kept, even when it alone is over budget. It is
/// the one the user is looking at, and deleting it the instant it was
/// written would mean re-rendering it on every single open: a cache that
/// makes things slower.
pub fn prune(dir: &Path, budget: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "hprx").unwrap_or(false))
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            Some((meta.modified().ok()?, meta.len(), e.path()))
        })
        .collect();
    // Newest first, keeping files until the budget runs out.
    files.sort_by_key(|(t, _, _)| std::cmp::Reverse(*t));
    let mut used: u64 = 0;
    for (i, (_, size, path)) in files.iter().enumerate() {
        used = used.saturating_add(*size);
        if used > budget && i > 0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// The proxy files in the cache, for reporting: how many and how many
/// bytes. Only the cache's own format counts; anything else in the
/// folder is not ours to report or touch.
pub fn inventory(dir: &Path) -> (u64, u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "hprx").unwrap_or(false))
        .filter_map(|e| e.metadata().ok().map(|m| m.len()))
        .fold((0, 0), |(n, b), len| (n + 1, b + len))
}

/// Drops every proxy: the user's own door, from Preferences, for
/// managing their disk. The prune above keeps the newest because it
/// runs behind the user's back; a clear the user asked for keeps
/// nothing, and every stack or panorama renders again on its next
/// open. Only .hprx files go; the folder and anything else in it stay.
/// Returns how many files were removed.
pub fn clear(dir: &Path) -> u64 {
    clear_watched(dir, &|| false, &mut |_, _| {}).unwrap_or(0)
}

/// clear with a should-stop flag and a progress callback (files
/// removed, files to remove). The list is collected before the first
/// removal, so a cancel between files is safe: what was removed is
/// gone, the rest stay, and the error says how far it got. Only .hprx
/// files go either way; the folder and anything else in it stay.
pub fn clear_watched(
    dir: &Path,
    should_stop: &dyn Fn() -> bool,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<u64, String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(0);
    };
    let targets: Vec<_> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "hprx").unwrap_or(false))
        .collect();
    let total = targets.len() as u64;
    let mut removed = 0u64;
    for path in targets {
        if should_stop() {
            return Err(format!("canceled; stopped after {removed} of {total} files"));
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
        progress(removed, total);
    }
    Ok(removed)
}

/// Total bytes the cache is currently holding, for reporting.
pub fn size_on_disk(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().map(|x| x == "hprx").unwrap_or(false))
        .filter_map(|e| e.metadata().ok().map(|m| m.len()))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Phase 6: a clear canceled between files keeps what was not yet
    /// removed, says how far it got, and the folder and foreign files
    /// are untouched either way.
    #[test]
    fn a_cancelled_clear_stops_between_files_and_says_how_far_it_got() {
        use std::sync::atomic::{AtomicU64, Ordering};
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(dir.path().join(format!("p{i}.hprx")), b"x").unwrap();
        }
        std::fs::write(dir.path().join("notes.txt"), b"keep").unwrap();
        let checks = AtomicU64::new(0);
        let mut ticks: Vec<(u64, u64)> = Vec::new();
        let err = clear_watched(
            dir.path(),
            &|| checks.fetch_add(1, Ordering::SeqCst) >= 2,
            &mut |removed, total| ticks.push((removed, total)),
        )
        .unwrap_err();
        assert!(err.contains("canceled"), "{err}");
        assert!(err.contains("stopped after 2 of 5"), "{err}");
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(left.len(), 4, "three .hprx files and the foreign file remain");
        assert!(dir.path().join("notes.txt").is_file());
        assert_eq!(ticks.len(), 2, "progress ran per removal");
        assert_eq!(ticks[0], (1, 5));
        // Unwatched, the rest go as before.
        assert_eq!(clear(dir.path()), 3);
        assert!(dir.path().join("notes.txt").is_file());
    }

    fn sample() -> ImageBuf {
        let mut img = ImageBuf::new(5, 3);
        for y in 0..3 {
            for x in 0..5 {
                let v = (y * 5 + x) as f32 * 0.37;
                img.set_pixel(x, y, [v, -v, v * 2.5, 1.0]);
            }
        }
        img
    }

    #[test]
    fn valid_proxy_is_refused_before_pixels_when_memory_is_busy() {
        let dir = tempfile::tempdir().unwrap();
        store(dir.path(), "limited", &sample());
        heeler_engine::memory::with_budget(16, || {
            let error = load_checked(dir.path(), "limited").unwrap_err();
            assert!(error.contains("Not enough memory"));
            assert!(error.contains("limited.hprx"));
            assert!(error.contains("more needed"));
        });
    }

    #[test]
    fn forged_proxy_geometry_overflows_without_allocating() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(dir.path().join("forged.hprx"), bytes).unwrap();
        assert!(load_checked(dir.path(), "forged").unwrap_err().contains("dimensions"));
    }

    #[test]
    fn a_proxy_round_trips_exactly() {
        let dir = tempfile::tempdir().unwrap();
        let img = sample();
        store(dir.path(), "abc", &img);
        let back = load(dir.path(), "abc").expect("just written");
        assert_eq!((back.width, back.height), (img.width, img.height));
        // Exactly, not nearly: this is a cache, and a cache that changes
        // the pixels is a bug that only shows up on the second open.
        assert_eq!(back.data, img.data);
    }

    /// Scene-linear values run past 1.0 and below 0. An 8-bit cache would
    /// clip precisely the highlights an HDR merge exists to recover.
    #[test]
    fn values_outside_the_display_range_survive() {
        let dir = tempfile::tempdir().unwrap();
        let mut img = ImageBuf::new(2, 1);
        img.set_pixel(0, 0, [7.25, 0.0, -0.5, 1.0]);
        img.set_pixel(1, 0, [1e-6, 12_000.0, 0.5, 1.0]);
        store(dir.path(), "hdr", &img);
        let back = load(dir.path(), "hdr").unwrap();
        assert_eq!(back.pixel(0, 0), [7.25, 0.0, -0.5, 1.0]);
        assert_eq!(back.pixel(1, 0), [1e-6, 12_000.0, 0.5, 1.0]);
    }

    #[test]
    fn a_missing_or_corrupt_proxy_is_a_miss_rather_than_an_error() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path(), "nothing").is_none());
        std::fs::write(dir.path().join("junk.hprx"), b"not a proxy at all").unwrap();
        assert!(load(dir.path(), "junk").is_none());
        // Right magic, truncated body: the header alone must not be
        // enough to hand back an image full of zeros.
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&100u32.to_le_bytes());
        bytes.extend_from_slice(&100u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 64]);
        std::fs::write(dir.path().join("short.hprx"), bytes).unwrap();
        assert!(load(dir.path(), "short").is_none());
    }

    #[test]
    fn an_enormous_header_without_pixels_is_a_cache_miss() {
        let dir = tempfile::tempdir().unwrap();
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&100_000u32.to_le_bytes());
        bytes.extend_from_slice(&100_000u32.to_le_bytes());
        std::fs::write(dir.path().join("huge.hprx"), bytes).unwrap();
        assert!(load(dir.path(), "huge").is_none());
    }

    #[test]
    fn a_proxy_with_trailing_payload_is_a_cache_miss() {
        let dir = tempfile::tempdir().unwrap();
        store(dir.path(), "extra", &ImageBuf::new(1, 1));
        let path = dir.path().join("extra.hprx");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.push(0);
        std::fs::write(path, bytes).unwrap();
        assert!(load(dir.path(), "extra").is_none());
    }

    /// The whole risk of a cache: serving yesterday's picture. Every
    /// input that changes the pixels has to change the key.
    #[test]
    fn the_key_changes_when_anything_that_matters_changes() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = dir.path().join("p.pano");
        std::fs::write(&manifest, r#"{"surface":"auto","members":["a.png"]}"#).unwrap();
        std::fs::write(dir.path().join("a.png"), b"first").unwrap();
        let members = vec!["a.png".to_string()];

        let base = key_for(&manifest, &members, "preview");
        assert_eq!(base, key_for(&manifest, &members, "preview"), "stable for the same inputs");

        // A different tier is a different picture.
        assert_ne!(base, key_for(&manifest, &members, "export"));

        // Editing the recipe.
        std::fs::write(&manifest, r#"{"surface":"spherical","members":["a.png"]}"#).unwrap();
        let after_recipe = key_for(&manifest, &members, "preview");
        assert_ne!(base, after_recipe, "changing the surface must invalidate");

        // Editing a member: caught by its size even when the clock has
        // not moved, which on a fast machine it may not have.
        std::fs::write(dir.path().join("a.png"), b"second, and longer").unwrap();
        assert_ne!(after_recipe, key_for(&manifest, &members, "preview"), "edited frame");

        // Losing a member changes the result too.
        std::fs::remove_file(dir.path().join("a.png")).unwrap();
        let gone = key_for(&manifest, &members, "preview");
        assert_ne!(after_recipe, gone, "a missing frame changes what renders");
    }

    /// Ages the proxies so the test does not depend on the filesystem's
    /// timestamp resolution, which on Windows is coarse enough that six
    /// writes in a row can share one.
    fn age(dir: &Path, key: &str, seconds: u64) {
        let when =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + seconds);
        let f = std::fs::File::options().write(true).open(path_for(dir, key)).unwrap();
        f.set_modified(when).unwrap();
    }

    #[test]
    fn pruning_keeps_the_newest_within_the_budget() {
        let dir = tempfile::tempdir().unwrap();
        let img = sample();
        for i in 0..6 {
            store(dir.path(), &format!("k{i}"), &img);
            age(dir.path(), &format!("k{i}"), i as u64 * 60);
        }
        let each = size_on_disk(dir.path()) / 6;
        // Room for two and a bit.
        prune(dir.path(), each * 2 + each / 2);
        assert!(load(dir.path(), "k5").is_some(), "newest kept");
        assert!(load(dir.path(), "k4").is_some());
        assert!(load(dir.path(), "k0").is_none(), "oldest dropped");
        assert!(load(dir.path(), "k3").is_none());
        assert!(size_on_disk(dir.path()) <= each * 3);
    }

    /// The files are wildly different sizes: a panorama preview is tens
    /// of megabytes and a full-resolution stack is most of a gigabyte. A
    /// count of files is not a disk budget, which is the bug this
    /// replaced.
    #[test]
    fn a_few_large_proxies_are_pruned_like_many_small_ones() {
        let dir = tempfile::tempdir().unwrap();
        let small = ImageBuf::new(4, 4);
        let large = ImageBuf::new(200, 200);
        store(dir.path(), "old_large", &large);
        age(dir.path(), "old_large", 0);
        store(dir.path(), "new_small", &small);
        age(dir.path(), "new_small", 600);

        let large_bytes = 200 * 200 * 16;
        // A budget that two files easily satisfy by count, and the large
        // one alone blows by size.
        prune(dir.path(), large_bytes / 2);
        assert!(load(dir.path(), "new_small").is_some(), "newest kept");
        assert!(load(dir.path(), "old_large").is_none(), "the big old one had to go");
    }

    /// One proxy bigger than the whole budget must survive, or the image
    /// the user is looking at is re-rendered on every open.
    #[test]
    fn the_newest_survives_even_when_it_alone_is_over_budget() {
        let dir = tempfile::tempdir().unwrap();
        store(dir.path(), "huge", &ImageBuf::new(100, 100));
        prune(dir.path(), 16);
        assert!(load(dir.path(), "huge").is_some(), "deleted the only thing worth keeping");
    }

    #[test]
    fn pruning_an_empty_or_missing_directory_is_harmless() {
        let dir = tempfile::tempdir().unwrap();
        prune(dir.path(), 4096);
        prune(&dir.path().join("does-not-exist"), 4096);
        assert_eq!(size_on_disk(&dir.path().join("does-not-exist")), 0);
    }
    #[test]
    fn clear_drops_every_proxy_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["a.hprx", "b.hprx", "c.hprx"] {
            std::fs::write(dir.path().join(name), vec![7u8; 1000]).unwrap();
        }
        std::fs::write(dir.path().join("notes.txt"), b"not ours").unwrap();
        assert_eq!(inventory(dir.path()), (3, 3000));
        assert_eq!(clear(dir.path()), 3);
        assert_eq!(inventory(dir.path()), (0, 0));
        assert!(dir.path().join("notes.txt").exists(), "a stray file is not the cache's to remove");
        assert_eq!(clear(dir.path()), 0, "cleared twice is zero, not an error");
        assert_eq!(clear(&dir.path().join("missing")), 0, "a folder that never existed is empty");
    }

}
