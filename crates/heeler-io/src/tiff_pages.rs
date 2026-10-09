//! Extra pages of a multi-page TIFF, and the first page's alpha
//! (26.3 Phase 6).
//!
//! A TIFF is a chain of image file directories; the generic decode
//! reads the first. This module walks the chain without decoding a
//! pixel (`pages`), so the desktop can report what a file carries, and
//! decodes one page on demand (`decode_page`) for the File node's
//! `layer` param.
//!
//! A layer editor's layered TIFF keeps its layer stack as a PSD blob in a
//! private tag (37724); the pages themselves are the flattened
//! composite and nothing more. We report the blob (`psd_blob`) so the
//! desktop can say the layers are unreadable rather than pretending
//! the file has none.

use std::io::Cursor;

use heeler_engine::buffers::ImageBuf;
use heeler_engine::memory::{self, Job};

use crate::{input_color, IoError};

/// One directory in the chain: a page, in file order.
#[derive(Debug, Clone, PartialEq)]
pub struct TiffPage {
    pub index: usize,
    pub width: u32,
    pub height: u32,
    pub samples: u16,
    pub bits: u16,
    /// A fourth (or second) sample the ExtraSamples tag owns up to.
    pub alpha: bool,
    /// A layer editor's layer stack rides tag 37724 as a PSD blob; out of
    /// scope, but said out loud.
    pub psd_blob: bool,
}

/// Whether the bytes lead with a TIFF header, classic or big.
pub fn is_tiff(bytes: &[u8]) -> bool {
    matches!(bytes.get(..4), Some(b"II*\0" | b"MM\0*" | b"II+\0" | b"MM\0+"))
}

/// Byte order and header size, or none for a non-TIFF.
fn header(bytes: &[u8]) -> Option<(bool, bool)> {
    let little = match bytes.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return None,
    };
    let read16 = |at: usize| -> Option<u16> {
        let b = bytes.get(at..at + 2)?;
        Some(if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    match read16(2)? {
        42 => Some((little, false)),
        43 => Some((little, true)),
        _ => None,
    }
}

/// Every page in the chain, without decoding a pixel. Empty for a
/// non-TIFF; an unreadable or truncated directory ends the walk with
/// what was gathered, the same bargain the decoders strike.
pub fn pages(bytes: &[u8]) -> Vec<TiffPage> {
    let Some((little, big)) = header(bytes) else { return Vec::new() };
    let word = |at: usize, len: usize| -> Option<u64> {
        let b = bytes.get(at..at + len)?;
        Some(if little {
            b.iter().enumerate().map(|(i, b)| (*b as u64) << (i * 8)).sum()
        } else {
            b.iter().fold(0u64, |n, b| (n << 8) | *b as u64)
        })
    };
    let entry_size = if big { 20usize } else { 12 };
    let mut offset = (if big { word(8, 8) } else { word(4, 4) }).unwrap_or(0) as usize;
    let mut out: Vec<TiffPage> = Vec::new();
    // A pathological file could cycle the chain; 256 pages is past
    // anything a still photograph carries.
    while offset != 0 && out.len() < 256 {
        let (count, entries_at) = if big {
            let Some(n) = word(offset, 8) else { break };
            (n as usize, offset + 8)
        } else {
            let Some(n) = word(offset, 2) else { break };
            (n as usize, offset + 2)
        };
        if count > 4096 || entries_at.checked_add(count * entry_size).is_none_or(|end| end > bytes.len()) {
            break;
        }
        // A directory entry: tag, type, count, then the value inline
        // when it fits or an offset to it. Every tag we read is a
        // SHORT or a LONG, so the first value is all we need.
        let field = |tag: u16| -> Option<u64> {
            for i in 0..count {
                let at = entries_at + i * entry_size;
                if word(at, 2)? != tag as u64 {
                    continue;
                }
                let ty = word(at + 2, 2)?;
                let n = word(at + 4, if big { 8 } else { 4 })?;
                let value_at = at + if big { 12 } else { 8 };
                let sample_size = match ty {
                    3 => 2u64,
                    4 => 4,
                    _ => return None,
                };
                let inline_width = if big { 8 } else { 4 };
                let first = if n * sample_size <= inline_width {
                    value_at
                } else {
                    word(value_at, if big { 8 } else { 4 })? as usize
                };
                return word(first, sample_size as usize);
            }
            None
        };
        // Tag presence, any type: the PSD blob is UNDEFINED data whose
        // value we never read, only note.
        let present = |tag: u16| -> bool {
            (0..count).any(|i| word(entries_at + i * entry_size, 2) == Some(tag as u64))
        };
        let samples = field(277).unwrap_or(1) as u16;
        out.push(TiffPage {
            index: out.len(),
            width: field(256).unwrap_or(0) as u32,
            height: field(257).unwrap_or(0) as u32,
            samples,
            bits: field(258).unwrap_or(8) as u16,
            alpha: present(338) || samples == 4 || samples == 2,
            psd_blob: present(37724),
        });
        // The next directory's offset trails the entries.
        let Some(next) = word(entries_at + count * entry_size, if big { 8 } else { 4 }) else { break };
        offset = next as usize;
    }
    out
}

/// One page decoded to a buffer, through the same ingest the generic
/// path gives page one: the file's profile applies to every page.
pub fn decode_page(bytes: &[u8], index: usize) -> Result<ImageBuf, IoError> {
    memory::catch(|| decode_page_admitted(bytes, index))
        .map_err(IoError::from)
        .and_then(|r| r)
}

fn decode_page_admitted(bytes: &[u8], index: usize) -> Result<ImageBuf, IoError> {
    let mut decoder = tiff::decoder::Decoder::new(Cursor::new(bytes))
        .map_err(|_| IoError::UnsupportedFormat)?;
    decoder.seek_to_image(index).map_err(|_| IoError::UnsupportedFormat)?;
    let (w, h) = decoder.dimensions().map_err(|_| IoError::UnsupportedFormat)?;
    let channels = match decoder.colortype().map_err(|_| IoError::UnsupportedFormat)? {
        tiff::ColorType::Gray(_) => 1usize,
        tiff::ColorType::GrayA(_) => 2,
        tiff::ColorType::RGB(_) => 3,
        tiff::ColorType::RGBA(_) => 4,
        _ => return Err(IoError::UnsupportedFormat),
    };
    let needed = memory::sum([memory::bytes(w as usize, h as usize, 1, 48)?, bytes.len()])?;
    let _job = Job::admit(needed, "TIFF page decode")?;
    let decoded = decoder.read_image().map_err(|e| IoError::Unsupported(format!("TIFF page {index}: {e}")))?;
    let sample: Box<dyn Fn(usize) -> f32> = match &decoded {
        tiff::decoder::DecodingResult::U8(v) => Box::new(move |at| v[at] as f32 / 255.0),
        tiff::decoder::DecodingResult::U16(v) => Box::new(move |at| v[at] as f32 / 65535.0),
        tiff::decoder::DecodingResult::F32(v) => Box::new(move |at| v[at]),
        // Gray and RGB in 8, 16 and float cover what a still carries;
        // the exotic widths stay honestly unreadable.
        _ => return Err(IoError::UnsupportedFormat),
    };
    let mut out = ImageBuf::try_new(w as usize, h as usize)?;
    for p in 0..w as usize * h as usize {
        let dest = &mut out.data[p * 4..p * 4 + 4];
        if channels < 3 {
            dest[..3].fill(sample(p * channels));
        } else {
            for c in 0..3 {
                dest[c] = sample(p * channels + c);
            }
        }
        dest[3] = if channels == 2 || channels == 4 { sample(p * channels + channels - 1) } else { 1.0 };
    }
    // Float pages are linear already (see decode_samples in lib.rs).
    if !matches!(decoded, tiff::decoder::DecodingResult::F32(_)) {
        let profile = input_color::tiff_profile(&mut Cursor::new(bytes));
        input_color::ingest(&mut out, profile.as_ref().map(|p| p.as_deref()).map_err(|e| *e));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One classic little-endian IFD entry. SHORT and LONG values that
    /// fit ride inline, low bytes first.
    fn entry(tag: u16, ty: u16, count: u32, value: u32) -> [u8; 12] {
        let mut e = [0u8; 12];
        e[0..2].copy_from_slice(&tag.to_le_bytes());
        e[2..4].copy_from_slice(&ty.to_le_bytes());
        e[4..8].copy_from_slice(&count.to_le_bytes());
        e[8..12].copy_from_slice(&value.to_le_bytes());
        e
    }

    /// A two-page RGBA8 TIFF assembled by hand: page one a red pixel at
    /// half alpha, page two a green opaque one, each 2x1. `psd` adds the
    /// PSD layer blob tag to page one.
    fn two_page(psd: bool) -> Vec<u8> {
        let w = 2u32;
        let h = 1u32;
        let pix0: [u8; 8] = [255, 0, 0, 128, 255, 0, 0, 128];
        let pix1: [u8; 8] = [0, 128, 0, 255, 0, 128, 0, 255];
        let tags = if psd { 11 } else { 10 };
        let ifd_len = 2 + tags * 12 + 4;
        let ifd0 = 8usize;
        let bits0 = ifd0 + ifd_len;
        let ifd1 = bits0 + 8;
        let bits1 = ifd1 + ifd_len;
        let data0 = bits1 + 8;
        let data1 = data0 + pix0.len();
        let ifd = |bits: usize, data: usize, next: usize, pixels: usize| -> Vec<u8> {
            let mut d = Vec::new();
            d.extend_from_slice(&(tags as u16).to_le_bytes());
            let mut es = vec![
                entry(256, 4, 1, w),                    // ImageWidth
                entry(257, 4, 1, h),                    // ImageLength
                entry(258, 3, 4, bits as u32),          // BitsPerSample (offset)
                entry(259, 3, 1, 1),                    // Compression: none
                entry(262, 3, 1, 2),                    // Photometric: RGB
                entry(273, 4, 1, data as u32),          // StripOffsets
                entry(277, 3, 1, 4),                    // SamplesPerPixel
                entry(278, 4, 1, h),                    // RowsPerStrip
                entry(279, 4, 1, pixels as u32),        // StripByteCounts
                entry(338, 3, 1, 2),                    // ExtraSamples: unassociated alpha
            ];
            if psd {
                es.push(entry(37724, 7, 4, 0));         // ImageSourceData: the PSD blob
                es.sort_by_key(|e| u16::from_le_bytes([e[0], e[1]]));
            }
            for e in es {
                d.extend_from_slice(&e);
            }
            d.extend_from_slice(&(next as u32).to_le_bytes());
            d
        };
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"II*\0");
        bytes.extend_from_slice(&(ifd0 as u32).to_le_bytes());
        bytes.extend_from_slice(&ifd(bits0, data0, ifd1, pix0.len()));
        bytes.extend_from_slice(&[8u8, 0, 8, 0, 8, 0, 8, 0]); // four SHORTs of 8 bits
        bytes.extend_from_slice(&ifd(bits1, data1, 0, pix1.len()));
        bytes.extend_from_slice(&[8u8, 0, 8, 0, 8, 0, 8, 0]);
        bytes.extend_from_slice(&pix0);
        bytes.extend_from_slice(&pix1);
        bytes
    }

    #[test]
    fn the_walk_reports_both_pages_and_their_alpha() {
        let found = pages(&two_page(false));
        assert_eq!(found.len(), 2);
        assert_eq!((found[0].width, found[0].height, found[0].samples, found[0].bits), (2, 1, 4, 8));
        assert!(found[0].alpha && found[1].alpha);
        assert!(!found[0].psd_blob);
        assert_eq!(found[1].index, 1);
    }

    #[test]
    fn a_psd_blob_is_noted_without_hiding_the_pages() {
        let found = pages(&two_page(true));
        assert_eq!(found.len(), 2, "the pages still report");
        assert!(found[0].psd_blob, "the blob is said out loud");
    }

    #[test]
    fn page_two_decodes_as_its_own_picture() {
        let img = decode_page(&two_page(false), 1).unwrap();
        assert_eq!((img.width, img.height), (2, 1));
        // Untagged reads as sRGB: green 128/255 display is ~0.212 linear.
        assert!((img.data[1] - 0.212).abs() < 0.01, "green: {}", img.data[1]);
        assert_eq!(img.data[3], 1.0, "page two is opaque");
    }

    #[test]
    fn page_one_alpha_arrives_in_the_fourth_sample() {
        let img = decode_page(&two_page(false), 0).unwrap();
        assert!((img.data[3] - 128.0 / 255.0).abs() < 0.001, "alpha: {}", img.data[3]);
        assert!((img.data[0] - 1.0).abs() < 0.001, "red: {}", img.data[0]);
    }

    #[test]
    fn a_page_past_the_end_is_an_honest_error() {
        assert!(decode_page(&two_page(false), 5).is_err());
        assert!(pages(b"not a tiff").is_empty());
    }
}
