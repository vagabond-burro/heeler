//! Embedded-preview extraction for camera RAW files. Original code, no
//! third-party decoder involved: TIFF-based RAWs (NEF, ARW, CR2, DNG)
//! advertise their embedded JPEG in IFD tags; anything else (CR3's
//! ISO-BMFF container) falls back to a bounded scan for the largest JPEG
//! stream. This gives preview-quality decode of RAW shoots today; true
//! sensor-level develop arrives with the LibRaw (CDDL) milestone behind
//! the same seam.

const TAG_STRIP_OFFSET: u16 = 0x0111;
const TAG_STRIP_LEN: u16 = 0x0117;
const TAG_COMPRESSION: u16 = 0x0103;
const TAG_PHOTOMETRIC: u16 = 0x0106;
const TAG_JPEG_OFFSET: u16 = 0x0201;
const TAG_JPEG_LEN: u16 = 0x0202;
const TAG_SUB_IFDS: u16 = 0x014a;

struct Reader<'a> {
    bytes: &'a [u8],
    little: bool,
}

impl<'a> Reader<'a> {
    fn u16_at(&self, at: usize) -> Option<u16> {
        let b = self.bytes.get(at..at + 2)?;
        Some(if self.little {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }

    fn u32_at(&self, at: usize) -> Option<u32> {
        let b = self.bytes.get(at..at + 4)?;
        let arr = [b[0], b[1], b[2], b[3]];
        Some(if self.little {
            u32::from_le_bytes(arr)
        } else {
            u32::from_be_bytes(arr)
        })
    }
}

fn is_jpeg(bytes: &[u8], offset: usize, len: usize) -> bool {
    len > 4
        && bytes
            .get(offset..offset + 2)
            .map(|b| b == [0xFF, 0xD8])
            .unwrap_or(false)
        && offset + len <= bytes.len()
}

/// Walks the IFD chain (plus SubIFDs) collecting embedded-JPEG candidates.
fn tiff_candidates(bytes: &[u8]) -> Vec<(usize, usize)> {
    let little = match bytes.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Vec::new(),
    };
    let r = Reader { bytes, little };
    if r.u16_at(2) != Some(42) {
        return Vec::new();
    }
    let mut queue: Vec<usize> = match r.u32_at(4) {
        Some(o) => vec![o as usize],
        None => return Vec::new(),
    };
    let mut seen = std::collections::HashSet::new();
    let mut found = Vec::new();

    while let Some(ifd) = queue.pop() {
        if !seen.insert(ifd) || seen.len() > 64 {
            continue;
        }
        let Some(count) = r.u16_at(ifd) else { continue };
        let mut jpeg = (None, None);
        let mut strip = (None, None);
        let mut compression = 0u32;
        let mut photometric = 0u32;
        for i in 0..count as usize {
            let e = ifd + 2 + i * 12;
            let (Some(tag), Some(ty), Some(n), Some(value)) =
                (r.u16_at(e), r.u16_at(e + 2), r.u32_at(e + 4), r.u32_at(e + 8))
            else {
                continue;
            };
            match tag {
                TAG_JPEG_OFFSET => jpeg.0 = Some(value as usize),
                TAG_JPEG_LEN => jpeg.1 = Some(value as usize),
                TAG_STRIP_OFFSET if n == 1 => strip.0 = Some(value as usize),
                TAG_STRIP_LEN if n == 1 => strip.1 = Some(value as usize),
                TAG_COMPRESSION if ty == 3 && n == 1 => compression = r.u16_at(e + 8).unwrap_or(0) as u32,
                TAG_COMPRESSION if ty == 4 && n == 1 => compression = value,
                TAG_PHOTOMETRIC if ty == 3 && n == 1 => photometric = r.u16_at(e + 8).unwrap_or(0) as u32,
                TAG_PHOTOMETRIC if ty == 4 && n == 1 => photometric = value,
                TAG_SUB_IFDS if ty == 4 => {
                    if n == 1 {
                        queue.push(value as usize);
                    } else {
                        for k in 0..n.min(16) as usize {
                            if let Some(off) = r.u32_at(value as usize + k * 4) {
                                queue.push(off as usize);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if let (Some(o), Some(l)) = jpeg {
            found.push((o, l));
        }
        // Old-JPEG (6) and new-JPEG (7) compressed strips are previews too,
        // unless the directory holds the photograph itself: a DNG's raw
        // image (a mosaic, 32803, or LinearRaw, 34892) is often lossless
        // JPEG in one strip, and it is the largest JPEG in the file. A
        // Samsung Expert RAW's 70 MB raw strip was taken for the preview,
        // would not decode as one, and the real preview beside it (8 MB)
        // was never tried (found on the pixls archive, 2026-10-03).
        let raw_image = photometric == 32803 || photometric == 34892;
        if (compression == 6 || compression == 7) && !raw_image && strip.0.is_some() && strip.1.is_some() {
            found.push((strip.0.unwrap(), strip.1.unwrap()));
        }
        if let Some(next) = r.u32_at(ifd + 2 + count as usize * 12) {
            if next != 0 {
                queue.push(next as usize);
            }
        }
    }
    found
}

/// Bounded fallback: largest FFD8..FFD9 stream in the file. Catches CR3 and
/// other non-TIFF containers. Minimum size filters out tiny thumbnails.
fn scan_candidates(bytes: &[u8], min_len: usize) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] == 0xFF && bytes[i + 1] == 0xD8 && bytes[i + 2] == 0xFF {
            let mut j = bytes.len() - 1;
            // Search backward for the last EOI after this SOI; entropy data
            // rarely contains a trailing FFD9 beyond the real one.
            while j > i + 3 {
                if bytes[j - 1] == 0xFF && bytes[j] == 0xD9 {
                    let len = j + 1 - i;
                    if len >= min_len {
                        found.push((i, len));
                    }
                    break;
                }
                j -= 1;
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    found
}

const TAG_ORIENTATION: u16 = 0x0112;

/// EXIF orientation (1..8) from a TIFF-style header at `bytes`, walking
/// the IFD0 chain. Accepts any magic (42 for TIFF/DNG/NEF, 0x55 for
/// Panasonic RW2, Olympus variants), since the IFD layout is identical.
fn tiff_orientation(bytes: &[u8]) -> Option<u16> {
    let little = match bytes.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return None,
    };
    let r = Reader { bytes, little };
    let mut ifd = r.u32_at(4)? as usize;
    let mut hops = 0;
    while ifd != 0 && hops < 8 {
        hops += 1;
        let count = r.u16_at(ifd)?;
        for i in 0..count as usize {
            let e = ifd + 2 + i * 12;
            if r.u16_at(e) == Some(TAG_ORIENTATION) {
                // SHORT value lives in the first two bytes of the value
                // field for both byte orders.
                let v = r.u16_at(e + 8)?;
                return (1..=8).contains(&v).then_some(v);
            }
        }
        ifd = r.u32_at(ifd + 2 + count as usize * 12)? as usize;
    }
    None
}

/// EXIF orientation from a JPEG's APP1 segment, if present.
fn jpeg_orientation(jpeg: &[u8]) -> Option<u16> {
    if jpeg.get(0..2) != Some(&[0xFF, 0xD8][..]) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        // Standalone markers without payload.
        if (0xD0..=0xD9).contains(&marker) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        if marker == 0xE1 && jpeg.get(i + 4..i + 10) == Some(b"Exif\0\0") {
            return tiff_orientation(jpeg.get(i + 10..i + 2 + len)?);
        }
        // Entropy-coded data follows SOS; no orientation past there.
        if marker == 0xDA {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// EXIF orientation of a standalone image file: a JPEG's APP1 segment or
/// a TIFF's IFD0. Returns 1 (upright) when nothing is found. This is what
/// phone JPEGs need: the camera stores pixels unrotated and describes the
/// device's attitude here.
pub fn media_orientation(bytes: &[u8]) -> u16 {
    jpeg_orientation(bytes)
        .or_else(|| tiff_orientation(bytes))
        .unwrap_or(1)
}

/// Best-effort EXIF orientation for a RAW container: the container's own
/// IFD0 first, then the embedded preview's EXIF. Returns 1 (upright) when
/// nothing is found.
pub fn raw_orientation(bytes: &[u8]) -> u16 {
    if let Some(o) = tiff_orientation(bytes) {
        return o;
    }
    if let Some(preview) = extract_raw_preview(bytes) {
        if let Some(o) = jpeg_orientation(preview) {
            return o;
        }
    }
    1
}

/// Returns the largest embedded JPEG preview in a RAW container, if any.
pub fn extract_raw_preview(bytes: &[u8]) -> Option<&[u8]> {
    let mut candidates: Vec<(usize, usize)> = tiff_candidates(bytes)
        .into_iter()
        .filter(|&(o, l)| is_jpeg(bytes, o, l))
        .collect();
    if candidates.is_empty() {
        candidates = scan_candidates(bytes, 1024)
            .into_iter()
            .filter(|&(o, l)| is_jpeg(bytes, o, l))
            .collect();
    }
    let (offset, len) = candidates.into_iter().max_by_key(|&(_, l)| l)?;
    bytes.get(offset..offset + len)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{decode_bytes, encode_jpeg};
    use heeler_engine::ImageBuf;

    fn sample_jpeg() -> Vec<u8> {
        // Textured content so the fixture exceeds the scanner's size floor.
        let mut img = ImageBuf::new(64, 48);
        for y in 0..48 {
            for x in 0..64 {
                img.set_pixel(x, y, [(x % 7) as f32 / 7.0, (y % 5) as f32 / 5.0, ((x + y) % 11) as f32 / 11.0, 1.0]);
            }
        }
        let jpeg = encode_jpeg(&img, 95).unwrap();
        assert!(jpeg.len() > 1024, "fixture must beat the scan floor");
        jpeg
    }

    #[test]
    fn big_endian_jpeg_strip_uses_its_declared_length() {
        let jpeg = sample_jpeg();
        let offset = 8 + 2 + 3 * 12 + 4;
        let mut bytes = b"MM\0*\0\0\0\x08".to_vec();
        bytes.extend(3u16.to_be_bytes());
        for (tag, kind, value) in [(259u16, 3u16, 7u32 << 16), (273, 4, offset as u32), (279, 4, jpeg.len() as u32)] {
            bytes.extend(tag.to_be_bytes());
            bytes.extend(kind.to_be_bytes());
            bytes.extend(1u32.to_be_bytes());
            bytes.extend(value.to_be_bytes());
        }
        bytes.extend(0u32.to_be_bytes());
        bytes.extend(&jpeg);
        // A second stream after the declared preview must not extend it.
        bytes.extend(&jpeg);
        assert_eq!(extract_raw_preview(&bytes).unwrap(), jpeg.as_slice());
    }

    #[test]
    fn a_dngs_raw_image_strip_is_never_taken_for_its_preview() {
        // A Samsung Expert RAW: the first directory is the photograph,
        // LinearRaw in one lossless JPEG strip, and the preview sits in
        // a SubIFD, a tenth its size. The largest JPEG in the file is
        // the photograph itself, which is no preview.
        let preview = sample_jpeg();
        let mut raw = preview.clone();
        raw.extend(std::iter::repeat(0u8).take(4096));
        let entry = |tag: u16, kind: u16, value: u32| {
            let mut e = tag.to_le_bytes().to_vec();
            e.extend(kind.to_le_bytes());
            e.extend(1u32.to_le_bytes());
            e.extend(if kind == 3 { [(value as u16).to_le_bytes(), [0, 0]].concat() } else { value.to_le_bytes().to_vec() });
            e
        };
        let first_at = 8usize;
        let sub_at = first_at + 2 + 5 * 12 + 4;
        let raw_at = sub_at + 2 + 4 * 12 + 4;
        let preview_at = raw_at + raw.len();
        let mut bytes = b"II*\0".to_vec();
        bytes.extend((first_at as u32).to_le_bytes());
        bytes.extend(5u16.to_le_bytes());
        for e in [entry(259, 3, 7), entry(262, 3, 34892), entry(273, 4, raw_at as u32), entry(279, 4, raw.len() as u32), entry(330, 4, sub_at as u32)] {
            bytes.extend(e);
        }
        bytes.extend(0u32.to_le_bytes());
        bytes.extend(4u16.to_le_bytes());
        for e in [entry(259, 3, 7), entry(262, 3, 6), entry(273, 4, preview_at as u32), entry(279, 4, preview.len() as u32)] {
            bytes.extend(e);
        }
        bytes.extend(0u32.to_le_bytes());
        bytes.extend(&raw);
        bytes.extend(&preview);
        assert_eq!(extract_raw_preview(&bytes).unwrap(), preview.as_slice());
        // A mosaic's strip (32803) is the photograph too.
        let cfa = bytes.windows(2).position(|w| w == 34892u16.to_le_bytes()).unwrap();
        bytes[cfa..cfa + 2].copy_from_slice(&32803u16.to_le_bytes());
        assert_eq!(extract_raw_preview(&bytes).unwrap(), preview.as_slice());
    }

    #[test]
    fn scan_finds_jpeg_inside_unknown_container() {
        let jpeg = sample_jpeg();
        let mut container = vec![0xAB; 9000];
        container.extend_from_slice(&jpeg);
        container.extend(vec![0xCD; 5000]);
        let preview = extract_raw_preview(&container).expect("preview found");
        let decoded = decode_bytes(preview).unwrap();
        assert_eq!((decoded.width, decoded.height), (64, 48));
    }

    #[test]
    fn tiff_ifd_pointer_wins_over_scanning() {
        // Minimal little-endian TIFF: IFD0 with JPEGInterchangeFormat tags.
        let jpeg = sample_jpeg();
        let jpeg_at = 8 + 2 + 2 * 12 + 4; // header + count + entries + next-ptr
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&42u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes()); // IFD0 at 8
        tiff.extend_from_slice(&2u16.to_le_bytes()); // two entries
        for (tag, value) in [(TAG_JPEG_OFFSET, jpeg_at as u32), (TAG_JPEG_LEN, jpeg.len() as u32)] {
            tiff.extend_from_slice(&tag.to_le_bytes());
            tiff.extend_from_slice(&4u16.to_le_bytes()); // LONG
            tiff.extend_from_slice(&1u32.to_le_bytes());
            tiff.extend_from_slice(&value.to_le_bytes());
        }
        tiff.extend_from_slice(&0u32.to_le_bytes()); // no next IFD
        assert_eq!(tiff.len(), jpeg_at);
        tiff.extend_from_slice(&jpeg);

        let preview = extract_raw_preview(&tiff).expect("preview via IFD");
        assert_eq!(preview.len(), jpeg.len());
        let decoded = decode_bytes(preview).unwrap();
        assert_eq!((decoded.width, decoded.height), (64, 48));
    }

    #[test]
    fn orientation_reads_from_container_ifd0_with_nonstandard_magic() {
        // RW2-style header: II + magic 0x55 instead of 42; orientation 6.
        let mut tiff = Vec::new();
        tiff.extend_from_slice(b"II");
        tiff.extend_from_slice(&0x55u16.to_le_bytes());
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&TAG_ORIENTATION.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes()); // SHORT
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&6u16.to_le_bytes());
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(raw_orientation(&tiff), 6);
        // Big-endian variant.
        let mut mm = Vec::new();
        mm.extend_from_slice(b"MM");
        mm.extend_from_slice(&42u16.to_be_bytes());
        mm.extend_from_slice(&8u32.to_be_bytes());
        mm.extend_from_slice(&1u16.to_be_bytes());
        mm.extend_from_slice(&TAG_ORIENTATION.to_be_bytes());
        mm.extend_from_slice(&3u16.to_be_bytes());
        mm.extend_from_slice(&1u32.to_be_bytes());
        mm.extend_from_slice(&8u16.to_be_bytes());
        mm.extend_from_slice(&[0, 0]);
        mm.extend_from_slice(&0u32.to_be_bytes());
        assert_eq!(raw_orientation(&mm), 8);
    }

    #[test]
    fn orientation_falls_back_to_embedded_jpeg_exif() {
        // Container with no IFD orientation, holding a JPEG whose APP1
        // EXIF says rotate 90 CW.
        let jpeg_body = sample_jpeg();
        let mut exif_tiff = Vec::new();
        exif_tiff.extend_from_slice(b"II");
        exif_tiff.extend_from_slice(&42u16.to_le_bytes());
        exif_tiff.extend_from_slice(&8u32.to_le_bytes());
        exif_tiff.extend_from_slice(&1u16.to_le_bytes());
        exif_tiff.extend_from_slice(&TAG_ORIENTATION.to_le_bytes());
        exif_tiff.extend_from_slice(&3u16.to_le_bytes());
        exif_tiff.extend_from_slice(&1u32.to_le_bytes());
        exif_tiff.extend_from_slice(&6u16.to_le_bytes());
        exif_tiff.extend_from_slice(&[0, 0]);
        exif_tiff.extend_from_slice(&0u32.to_le_bytes());

        let mut app1 = Vec::new();
        app1.extend_from_slice(b"Exif\0\0");
        app1.extend_from_slice(&exif_tiff);
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpeg.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
        jpeg.extend_from_slice(&app1);
        jpeg.extend_from_slice(&jpeg_body[2..]); // rest of a real JPEG

        let mut container = vec![0xAB; 4096];
        container.extend_from_slice(&jpeg);
        container.extend(vec![0xCD; 1024]);
        assert_eq!(raw_orientation(&container), 6);
        // No orientation anywhere: upright default.
        assert_eq!(raw_orientation(&vec![0u8; 4096]), 1);
    }

    #[test]
    fn no_preview_means_none_not_garbage() {
        assert!(extract_raw_preview(&vec![0u8; 20000]).is_none());
        assert!(extract_raw_preview(b"II\x2a\x00\x08\x00\x00\x00\x00\x00").is_none());
    }
}
