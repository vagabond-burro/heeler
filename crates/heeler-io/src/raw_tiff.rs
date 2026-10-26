//! A camera raw that wears a TIFF's extension: the Kodak DCS bodies,
//! Canon's EOS-1D, EOS-1Ds and D2000, and Phase One backs saved their
//! raws as .TIF. The first image in such a file is a small RGB
//! thumbnail, which is all a TIFF reader sees, so the loader has to hand
//! the file to LibRaw instead. LibRaw is the judge: it recognizes these
//! and refuses an ordinary TIFF, Heeler's own exports included, even one
//! that carries a camera's make.
//!
//! Most callers ask with a path alone, and some ask under every preview
//! render, so the answer is kept per file (its path, modified time and
//! length, the identity every other cache trusts for a file's content).
//! A cheap look at the first directory comes first: a raw's opens on a
//! thumbnail and names its camera, so a TIFF whose first image is
//! large, or that names no camera, is answered without reading the rest.

use std::{
    collections::HashMap,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};

/// The longest side a raw's first image (its thumbnail) has had: 608 on
/// a Phase One IQ140. A photograph saved as a TIFF opens on itself.
const THUMBNAIL_SIDE: u32 = 1024;

const TAG_WIDTH: u16 = 256;
const TAG_HEIGHT: u16 = 257;
const TAG_MAKE: u16 = 271;

type Identity = (Option<SystemTime>, u64);

fn seen() -> &'static Mutex<HashMap<PathBuf, (Identity, bool)>> {
    static SEEN: OnceLock<Mutex<HashMap<PathBuf, (Identity, bool)>>> = OnceLock::new();
    SEEN.get_or_init(Default::default)
}

/// Whether the .tif at `path` is a camera raw LibRaw develops. `bytes`,
/// when the caller already holds the whole file, saves reading it again.
pub(crate) fn at(path: &Path, bytes: Option<&[u8]>) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return bytes.is_some_and(is_raw_tiff);
    };
    let id = (meta.modified().ok(), meta.len());
    if let Some(&(was, raw)) = seen().lock().unwrap_or_else(|e| e.into_inner()).get(path) {
        if was == id {
            return raw;
        }
    }
    let raw = match bytes {
        Some(b) => is_raw_tiff(b),
        None => read_and_judge(path),
    };
    seen().lock().unwrap_or_else(|e| e.into_inner()).insert(path.to_path_buf(), (id, raw));
    raw
}

fn read_and_judge(path: &Path) -> bool {
    // Only the first directory is read to screen the file. It can sit
    // anywhere: a Phase One back writes it after the raw, 47 MB in.
    let screen = || -> std::io::Result<bool> {
        let mut file = std::fs::File::open(path)?;
        let mut head = [0u8; 8];
        file.read_exact(&mut head)?;
        let Some((little, ifd0)) = header(&head) else { return Ok(false) };
        file.seek(SeekFrom::Start(ifd0 as u64))?;
        let mut dir = vec![0u8; 2];
        file.read_exact(&mut dir)?;
        let count = if little { u16::from_le_bytes([dir[0], dir[1]]) } else { u16::from_be_bytes([dir[0], dir[1]]) };
        file.take(count as u64 * 12).read_to_end(&mut dir)?;
        Ok(directory(little, &dir))
    };
    if !screen().unwrap_or(false) {
        return false;
    }
    // LibRaw needs the whole file.
    std::fs::read(path).is_ok_and(|b| is_raw_tiff(&b))
}

fn is_raw_tiff(bytes: &[u8]) -> bool {
    screened(bytes) && libraw_knows(bytes)
}

#[cfg(feature = "raw")]
fn libraw_knows(bytes: &[u8]) -> bool {
    heeler_raw::picture_dimensions(bytes).is_ok()
}

#[cfg(not(feature = "raw"))]
fn libraw_knows(_: &[u8]) -> bool {
    false
}

/// A first directory that names a camera and holds a thumbnail.
fn screened(bytes: &[u8]) -> bool {
    header(bytes).is_some_and(|(little, ifd0)| bytes.get(ifd0..).is_some_and(|dir| directory(little, dir)))
}

/// The byte order and where the first directory is.
fn header(bytes: &[u8]) -> Option<(bool, usize)> {
    let little = match bytes.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let magic: [u8; 2] = bytes.get(2..4)?.try_into().ok()?;
    let ifd0: [u8; 4] = bytes.get(4..8)?.try_into().ok()?;
    let (magic, ifd0) = if little {
        (u16::from_le_bytes(magic), u32::from_le_bytes(ifd0))
    } else {
        (u16::from_be_bytes(magic), u32::from_be_bytes(ifd0))
    };
    (magic == 42).then_some((little, ifd0 as usize))
}

/// A directory, from its entry count on, that names a camera (Make) and
/// whose image is no bigger than a thumbnail. Only inline values are
/// read, so the directory's own bytes are enough.
fn directory(little: bool, dir: &[u8]) -> bool {
    let u16_at = |at: usize| {
        let b: [u8; 2] = dir.get(at..at + 2)?.try_into().ok()?;
        Some(if little { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    };
    let u32_at = |at: usize| {
        let b: [u8; 4] = dir.get(at..at + 4)?.try_into().ok()?;
        Some(if little { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    };
    let Some(count) = u16_at(0) else { return false };
    let (mut make, mut width, mut height) = (false, None, None);
    for i in 0..count as usize {
        let p = 2 + i * 12;
        let (Some(tag), Some(kind)) = (u16_at(p), u16_at(p + 2)) else { return false };
        // A size is a SHORT or a LONG, held inline.
        let size = || match kind {
            3 => u16_at(p + 8).map(u32::from),
            4 => u32_at(p + 8),
            _ => None,
        };
        match tag {
            TAG_MAKE => make = true,
            TAG_WIDTH => width = size(),
            TAG_HEIGHT => height = size(),
            _ => {}
        }
    }
    matches!((make, width, height), (true, Some(w), Some(h)) if w.max(h) <= THUMBNAIL_SIDE)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian TIFF whose first directory holds a width, a
    /// height and, if asked, a Make.
    fn tiff(width: u32, height: u32, make: bool) -> Vec<u8> {
        let mut entries: Vec<(u16, u16, u32)> = vec![(TAG_WIDTH, 4, width), (TAG_HEIGHT, 3, height)];
        if make {
            entries.push((TAG_MAKE, 2, 0));
        }
        let mut b = b"II*\0".to_vec();
        b.extend_from_slice(&8u32.to_le_bytes());
        b.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        for (tag, kind, value) in entries {
            b.extend_from_slice(&tag.to_le_bytes());
            b.extend_from_slice(&kind.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes());
            b.extend_from_slice(&value.to_le_bytes());
        }
        b.extend_from_slice(&0u32.to_le_bytes());
        b
    }

    #[test]
    fn only_a_camera_named_thumbnail_is_screened_in() {
        assert!(screened(&tiff(156, 104, true)));
        assert!(screened(&tiff(608, 1024, true)));
        assert!(!screened(&tiff(156, 104, false)), "no camera named");
        assert!(!screened(&tiff(6000, 4000, true)), "the photograph itself comes first");
        assert!(!screened(&tiff(156, 104, true)[..20]), "a directory cut short");
        assert!(!screened(b"not a tiff at all"));
    }

    /// Heeler's own TIFF exports go on being read as TIFFs, a small one
    /// carrying a camera's make included.
    #[test]
    fn a_heeler_tiff_export_is_not_a_raw() {
        let img = heeler_engine::ImageBuf::new(160, 120);
        let exif = crate::exif::Exif { make: Some("Kodak".into()), model: Some("DCS520C".into()), ..Default::default() };
        for bytes in [
            crate::bake::encode_tiff16(&img).unwrap(),
            crate::bake::encode_tiff16_export(&img, crate::bake::TiffExportOptions { exif: Some(&exif), xmp: None, dpi: 300 }).unwrap(),
        ] {
            assert!(!is_raw_tiff(&bytes));
        }
    }

    /// The answer is kept per file and asked again when the file changes.
    #[test]
    fn the_answer_follows_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.tif");
        std::fs::write(&path, tiff(156, 104, true)).unwrap();
        assert!(!at(&path, None), "screened in, but LibRaw does not know it");
        seen().lock().unwrap().insert(path.clone(), ((std::fs::metadata(&path).unwrap().modified().ok(), 0), true));
        assert!(!at(&path, None), "a stale answer (another length) is not used");
        let len = std::fs::metadata(&path).unwrap().len();
        seen().lock().unwrap().insert(path.clone(), ((std::fs::metadata(&path).unwrap().modified().ok(), len), true));
        assert!(at(&path, None), "a kept answer for the same file is");
    }
}
