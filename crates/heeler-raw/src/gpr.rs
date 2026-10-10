//! GoPro GPR: a DNG whose raw image is one tile compressed with GoPro's
//! VC-5 codec (DNG compression 9). LibRaw reads that only through the
//! GPR SDK, which needs Adobe's DNG SDK, so Heeler decodes the tile
//! itself with the SDK's VC-5 decoder (third_party/gpr-vc5) and hands
//! LibRaw the same file with the tile uncompressed: the decoded samples
//! appended, and Compression, TileOffsets and TileByteCounts pointed at
//! them. Every other tag (CFA pattern, black and white levels, color
//! matrices, EXIF) is the camera's, untouched, and every other file
//! never comes here.

use std::ffi::c_void;
use std::os::raw::c_int;

use crate::RawError;

extern "C" {
    fn heeler_vc5_decode(
        data: *const c_void,
        len: usize,
        rggb: c_int,
        width: c_int,
        height: c_int,
        out: *mut *mut c_void,
        out_len: *mut usize,
    ) -> c_int;
    fn heeler_vc5_free(block: *mut c_void);
}

const COMPRESSION: u16 = 259;
const WIDTH: u16 = 256;
const LENGTH: u16 = 257;
const BITS_PER_SAMPLE: u16 = 258;
const TILE_WIDTH: u16 = 322;
const TILE_LENGTH: u16 = 323;
const TILE_OFFSETS: u16 = 324;
const TILE_BYTE_COUNTS: u16 = 325;
const CFA_PATTERN: u16 = 33422;
/// DNG's compression code for VC-5 (the GPR SDK's ccVc5).
const VC5: u32 = 9;

/// One IFD entry: where it sits in the file, its type and count, and its
/// first value when that value is held in the entry itself.
#[derive(Clone, Copy)]
struct Entry {
    at: usize,
    kind: u16,
    count: u32,
    value: u32,
}

struct Tiff<'a> {
    bytes: &'a [u8],
    big: bool,
}

impl Tiff<'_> {
    fn u16(&self, at: usize) -> Option<u16> {
        let b: [u8; 2] = self.bytes.get(at..at + 2)?.try_into().ok()?;
        Some(if self.big { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) })
    }
    fn u32(&self, at: usize) -> Option<u32> {
        let b: [u8; 4] = self.bytes.get(at..at + 4)?.try_into().ok()?;
        Some(if self.big { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) })
    }
    /// The first IFD's entries, by tag.
    fn ifd0(&self) -> Option<Vec<(u16, Entry)>> {
        let at = self.u32(4)? as usize;
        let n = self.u16(at)? as usize;
        (0..n)
            .map(|i| {
                let e = at + 2 + 12 * i;
                let kind = self.u16(e + 2)?;
                let value = match kind {
                    1 | 7 => *self.bytes.get(e + 8)? as u32,
                    3 => self.u16(e + 8)? as u32,
                    _ => self.u32(e + 8)?,
                };
                Some((self.u16(e)?, Entry { at: e, kind, count: self.u32(e + 4)?, value }))
            })
            .collect()
    }
}

/// True when the bytes are a GPR: a TIFF whose first IFD is a VC-5 tile.
pub fn is_gpr(bytes: &[u8]) -> bool {
    tiff(bytes).and_then(|t| t.ifd0()).is_some_and(|ifd| find(&ifd, COMPRESSION).is_some_and(|e| e.value == VC5))
}

/// A GPR's size from its header alone, without decoding the tile: the
/// raw width and height LibRaw reports for the decoded file, which are
/// the DNG's own. None when the bytes are not a GPR.
pub fn dimensions(bytes: &[u8]) -> Option<(usize, usize)> {
    let ifd = tiff(bytes)?.ifd0()?;
    if !find(&ifd, COMPRESSION).is_some_and(|e| e.value == VC5) {
        return None;
    }
    Some((find(&ifd, WIDTH)?.value as usize, find(&ifd, LENGTH)?.value as usize))
}

fn tiff(bytes: &[u8]) -> Option<Tiff<'_>> {
    match bytes.get(..4)? {
        b"II*\0" => Some(Tiff { bytes, big: false }),
        b"MM\0*" => Some(Tiff { bytes, big: true }),
        _ => None,
    }
}

fn find(ifd: &[(u16, Entry)], tag: u16) -> Option<Entry> {
    ifd.iter().find(|(t, _)| *t == tag).map(|(_, e)| *e)
}

fn bad(why: &str) -> RawError {
    RawError::Code(format!("GoPro GPR: {why}"), -1)
}

/// The GPR as a DNG LibRaw reads, or None when the bytes are not a GPR.
pub fn as_dng(bytes: &[u8]) -> Result<Option<Vec<u8>>, RawError> {
    as_dng_with(bytes, decode)
}

/// `as_dng` with the tile decoder passed in, so the rewrite can be tested
/// on a synthetic file without a VC-5 bitstream. The decoder is handed
/// the tile, whether the sensor is RGGB, and the image's width and height.
fn as_dng_with<S: AsRef<[u8]>>(
    bytes: &[u8],
    decode: impl Fn(&[u8], bool, usize, usize) -> Result<S, RawError>,
) -> Result<Option<Vec<u8>>, RawError> {
    let Some(t) = tiff(bytes) else { return Ok(None) };
    let Some(ifd) = t.ifd0() else { return Ok(None) };
    if !find(&ifd, COMPRESSION).is_some_and(|e| e.value == VC5) {
        return Ok(None);
    }
    let tag = |id: u16, what: &str| find(&ifd, id).ok_or_else(|| bad(&format!("no {what}")));
    let (w, h) = (tag(WIDTH, "width")?.value as usize, tag(LENGTH, "length")?.value as usize);
    if w == 0 || h == 0 {
        return Err(bad("an empty image"));
    }
    // One tile the size of the image, 16 bits a sample: the only shape
    // GoPro writes and the only one the SDK's reader decodes.
    let offsets = tag(TILE_OFFSETS, "tile offsets")?;
    let counts = tag(TILE_BYTE_COUNTS, "tile byte counts")?;
    if offsets.count != 1
        || counts.count != 1
        || tag(TILE_WIDTH, "tile width")?.value as usize != w
        || tag(TILE_LENGTH, "tile length")?.value as usize != h
        || tag(BITS_PER_SAMPLE, "bits per sample")?.value != 16
    {
        return Err(bad("not the single 16-bit tile GoPro writes"));
    }
    let start = offsets.value as usize;
    let tile = bytes.get(start..start + counts.value as usize).ok_or_else(|| bad("the tile runs past the end of the file"))?;
    // The SDK's choice: an RGGB sensor (HERO5 to HERO7, Fusion) is 14-bit,
    // any other (GBRG, HERO8 on) 12-bit.
    let cfa = find(&ifd, CFA_PATTERN).filter(|e| e.count == 4 && e.kind == 1).ok_or_else(|| bad("no 2x2 CFA pattern"))?;
    let pattern = bytes.get(cfa.at + 8..cfa.at + 12).ok_or_else(|| bad("no 2x2 CFA pattern"))?;
    let rggb = pattern == [0, 1, 1, 2];
    // The rewritten offsets are LONGs: refuse a file they cannot address
    // before decoding anything.
    let at = bytes.len().next_multiple_of(4);
    let size = w.checked_mul(h).and_then(|n| n.checked_mul(2)).ok_or_else(|| bad("too large to rewrite"))?;
    if at.checked_add(size).is_none_or(|end| end > u32::MAX as usize) {
        return Err(bad("too large to rewrite"));
    }

    // The decoder's wavelets and output peak near 6.6 bytes a pixel
    // (measured 2026-10-09: 196 MB for a 27 megapixel HERO11 frame with
    // its 14 MB tile), so eight, plus the file it reads.
    let needed = heeler_engine::memory::sum([heeler_engine::memory::bytes(w, h, 1, 8)?, bytes.len()])?;
    let _job = heeler_engine::memory::Job::admit(needed, "GoPro GPR decode")?;
    let decoded = decode(tile, rggb, w, h)?;
    let samples = decoded.as_ref();
    if samples.len() != size {
        return Err(bad(&format!("the tile decoded to {} bytes, not {size}", samples.len())));
    }

    // Appended on a four-byte boundary, in the file's own byte order (the
    // decoder writes the machine's).
    let mut out = Vec::with_capacity(at + size);
    out.extend_from_slice(bytes);
    out.resize(at, 0);
    if t.big == cfg!(target_endian = "big") {
        out.extend_from_slice(samples);
    } else {
        out.extend(samples.chunks_exact(2).flat_map(|s| [s[1], s[0]]));
    }
    drop(decoded);
    let big = t.big;
    let put16 = |out: &mut Vec<u8>, at: usize, v: u16| {
        out[at..at + 2].copy_from_slice(&if big { v.to_be_bytes() } else { v.to_le_bytes() });
    };
    let put32 = |out: &mut Vec<u8>, at: usize, v: u32| {
        out[at..at + 4].copy_from_slice(&if big { v.to_be_bytes() } else { v.to_le_bytes() });
    };
    // Each value is held in its own entry (a count of one), so it is
    // rewritten where it stands; the offset and count become LONGs.
    let compression = tag(COMPRESSION, "compression")?;
    put16(&mut out, compression.at + 2, 3);
    put32(&mut out, compression.at + 8, 0);
    put16(&mut out, compression.at + 8, 1);
    for (entry, value) in [(offsets, at as u32), (counts, size as u32)] {
        put16(&mut out, entry.at + 2, 4);
        put32(&mut out, entry.at + 8, value);
    }
    Ok(Some(out))
}

/// The decoder's output, freed by the decoder's allocator when dropped.
struct Decoded {
    ptr: *mut c_void,
    len: usize,
}

impl AsRef<[u8]> for Decoded {
    fn as_ref(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.ptr as *const u8, self.len) }
    }
}

impl Drop for Decoded {
    fn drop(&mut self) {
        unsafe { heeler_vc5_free(self.ptr) };
    }
}

/// The tile's samples, two bytes each in the machine's byte order. The
/// width and height are the DNG's; a stream that says otherwise is refused.
fn decode(tile: &[u8], rggb: bool, width: usize, height: usize) -> Result<Decoded, RawError> {
    let (Ok(w), Ok(h)) = (c_int::try_from(width), c_int::try_from(height)) else {
        return Err(bad("too large to decode"));
    };
    let mut ptr: *mut c_void = std::ptr::null_mut();
    let mut len = 0usize;
    let code = unsafe { heeler_vc5_decode(tile.as_ptr() as *const c_void, tile.len(), rggb as c_int, w, h, &mut ptr, &mut len) };
    if code != 0 || ptr.is_null() {
        return Err(bad(&format!("the VC-5 decoder failed ({code})")));
    }
    Ok(Decoded { ptr, len })
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A little-endian or big-endian TIFF with one IFD shaped like a GPR's:
    /// the given tags (id, type, value) in order, and a tile of `tile`
    /// bytes after the directory.
    fn tiff_with(big: bool, tags: &[(u16, u16, u32)], tile: &[u8]) -> Vec<u8> {
        let u16b = |v: u16| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let u32b = |v: u32| if big { v.to_be_bytes() } else { v.to_le_bytes() };
        let mut out = if big { b"MM\0*".to_vec() } else { b"II*\0".to_vec() };
        out.extend_from_slice(&u32b(8));
        let tile_at = 8 + 2 + 12 * tags.len() as u32 + 4;
        out.extend_from_slice(&u16b(tags.len() as u16));
        for &(id, kind, value) in tags {
            let value = if id == TILE_OFFSETS { tile_at } else { value };
            out.extend_from_slice(&u16b(id));
            out.extend_from_slice(&u16b(kind));
            out.extend_from_slice(&u32b(if id == CFA_PATTERN { 4 } else { 1 }));
            match kind {
                3 => {
                    out.extend_from_slice(&u16b(value as u16));
                    out.extend_from_slice(&[0, 0]);
                }
                1 => out.extend_from_slice(&value.to_be_bytes()),
                _ => out.extend_from_slice(&u32b(value)),
            }
        }
        out.extend_from_slice(&u32b(0));
        out.extend_from_slice(tile);
        out
    }

    /// A 4x2 GPR: RGGB (CFA bytes 0, 1, 1, 2) or GBRG.
    fn gpr(big: bool, rggb: bool, tile: &[u8]) -> Vec<u8> {
        let cfa = if rggb { 0x0001_0102 } else { 0x0102_0001 };
        tiff_with(
            big,
            &[
                (WIDTH, 4, 4),
                (LENGTH, 4, 2),
                (BITS_PER_SAMPLE, 3, 16),
                (COMPRESSION, 3, VC5),
                (TILE_WIDTH, 4, 4),
                (TILE_LENGTH, 4, 2),
                (TILE_OFFSETS, 4, 0),
                (TILE_BYTE_COUNTS, 4, tile.len() as u32),
                (CFA_PATTERN, 1, cfa),
            ],
            tile,
        )
    }

    /// A stand-in decoder: eight samples 1..=8 in machine order, and the
    /// sensor order and size it was asked for.
    type Seen = std::cell::Cell<Option<(bool, usize, usize)>>;
    fn fake(seen: &Seen) -> impl Fn(&[u8], bool, usize, usize) -> Result<Vec<u8>, RawError> + '_ {
        move |_tile, rggb, w, h| {
            seen.set(Some((rggb, w, h)));
            Ok((1u16..=8).flat_map(|v| v.to_ne_bytes()).collect())
        }
    }

    #[test]
    fn a_gpr_becomes_the_same_dng_with_its_tile_uncompressed() {
        for big in [false, true] {
            let input = gpr(big, true, b"vc5 bits");
            let seen = std::cell::Cell::new(None);
            let out = as_dng_with(&input, fake(&seen)).unwrap().unwrap();
            assert_eq!(seen.get(), Some((true, 4, 2)), "RGGB asks for the 14-bit decode, at the DNG's size");
            let t = tiff(&out).unwrap();
            let ifd = t.ifd0().unwrap();
            assert_eq!(find(&ifd, COMPRESSION).unwrap().value, 1, "uncompressed");
            let at = find(&ifd, TILE_OFFSETS).unwrap();
            let count = find(&ifd, TILE_BYTE_COUNTS).unwrap();
            assert_eq!((at.kind, count.kind, count.value), (4, 4, 16));
            assert_eq!(at.value % 4, 0, "the samples start on a four-byte boundary");
            assert_eq!(at.value as usize + 16, out.len(), "appended at the end");
            let samples: Vec<u16> = (0..8).map(|i| t.u16(at.value as usize + 2 * i).unwrap()).collect();
            assert_eq!(samples, (1..=8).collect::<Vec<u16>>(), "in the file's own byte order (big {big})");
            // Everything before the appended samples is the original file,
            // but for the three rewritten values.
            let mut expect = input.clone();
            let fixed = |id: u16| find(&ifd, id).unwrap().at;
            for id in [COMPRESSION, TILE_OFFSETS, TILE_BYTE_COUNTS] {
                expect[fixed(id) + 2..fixed(id) + 12].copy_from_slice(&out[fixed(id) + 2..fixed(id) + 12]);
            }
            assert_eq!(&out[..input.len()], &expect[..]);
            assert_eq!(dimensions(&input), Some((4, 2)), "the header answers without a decode");
        }
    }

    #[test]
    fn a_gbrg_sensor_asks_for_the_12_bit_decode() {
        let seen = std::cell::Cell::new(None);
        as_dng_with(&gpr(false, false, b"vc5"), fake(&seen)).unwrap().unwrap();
        assert_eq!(seen.get(), Some((false, 4, 2)));
    }

    #[test]
    fn anything_but_a_gpr_passes_through_untouched() {
        let never = |_: &[u8], _: bool, _: usize, _: usize| -> Result<Vec<u8>, RawError> { panic!("decoded a file that is not a GPR") };
        let plain = tiff_with(false, &[(WIDTH, 4, 4), (LENGTH, 4, 2), (COMPRESSION, 3, 1)], b"");
        for bytes in [&b""[..], b"II*", b"\xff\xd8\xff\xe0 a jpeg", b"FUJIFILMCCD-RAW ", &plain] {
            assert!(!is_gpr(bytes));
            assert_eq!(dimensions(bytes), None);
            assert!(as_dng_with(bytes, never).unwrap().is_none());
        }
    }

    #[test]
    fn a_damaged_gpr_is_an_error_not_a_crash() {
        let ok = |_: &[u8], _: bool, _: usize, _: usize| -> Result<Vec<u8>, RawError> { Ok(vec![0; 16]) };
        // The tile runs past the end of the file.
        let mut cut = gpr(false, true, b"vc5 bits");
        cut.truncate(cut.len() - 3);
        assert!(as_dng_with(&cut, ok).is_err());
        // A decode of the wrong size.
        let short = |_: &[u8], _: bool, _: usize, _: usize| -> Result<Vec<u8>, RawError> { Ok(vec![0; 10]) };
        assert!(as_dng_with(&gpr(false, true, b"vc5"), short).is_err());
        // Not the single 16-bit tile GoPro writes.
        let mut twelve = gpr(false, true, b"vc5");
        let t = tiff(&twelve).unwrap();
        let bps = find(&t.ifd0().unwrap(), BITS_PER_SAMPLE).unwrap().at;
        twelve[bps + 8] = 12;
        assert!(as_dng_with(&twelve, ok).is_err());
        // The real decoder on tiles that are no VC-5 stream at all.
        let mut seed = 7u32;
        let junk: Vec<u8> = (0..4096).map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 24) as u8
        }).collect();
        for tile in [&b""[..], &b"\0"[..], &junk[..16], &junk[..]] {
            assert!(decode(tile, true, 4, 2).is_err(), "{} bytes", tile.len());
            assert!(as_dng(&gpr(false, true, tile)).is_err());
        }
    }

    #[test]
    fn a_vc5_header_naming_another_size_is_refused_before_it_allocates() {
        // The bitstream's own header, big-endian tag and value pairs after
        // the "VC-5" marker: four channels, then a width and height. A
        // damaged width of 0xFFFF once sized an 838 MB allocation.
        let header = |w: u16, h: u16| -> Vec<u8> {
            let mut v = b"VC-5".to_vec();
            for (tag, value) in [(12u16, 4u16), (20, w), (21, h), (84, 4), (106, 2), (107, 2), (108, 1)] {
                v.extend_from_slice(&tag.to_be_bytes());
                v.extend_from_slice(&value.to_be_bytes());
            }
            v.resize(4096, 0);
            v
        };
        for (w, h) in [(0xFFFF, 2), (4, 0xFFFF), (8, 2), (4, 4)] {
            let Err(e) = decode(&header(w, h), true, 4, 2) else { panic!("{w}x{h} decoded") };
            assert!(e.to_string().contains(&format!("({})", 6)), "{w}x{h}: {e}, not the image dimensions error");
        }
    }

    #[test]
    fn short_offset_and_count_entries_become_longs() {
        // GoPro writes LONGs; a file that held its offset and count in
        // SHORTs must still point LibRaw at the appended samples.
        let input = tiff_with(
            false,
            &[
                (WIDTH, 4, 4),
                (LENGTH, 4, 2),
                (BITS_PER_SAMPLE, 3, 16),
                (COMPRESSION, 3, VC5),
                (TILE_WIDTH, 4, 4),
                (TILE_LENGTH, 4, 2),
                (TILE_OFFSETS, 3, 0),
                (TILE_BYTE_COUNTS, 3, 3),
                (CFA_PATTERN, 1, 0x0001_0102),
            ],
            b"vc5",
        );
        let seen = Seen::new(None);
        let out = as_dng_with(&input, fake(&seen)).unwrap().unwrap();
        let ifd = tiff(&out).unwrap().ifd0().unwrap();
        let (at, count) = (find(&ifd, TILE_OFFSETS).unwrap(), find(&ifd, TILE_BYTE_COUNTS).unwrap());
        assert_eq!((at.kind, count.kind), (4, 4));
        assert_eq!(count.value, 16);
        assert_eq!(at.value as usize + 16, out.len());
    }

    #[test]
    fn a_frame_the_rewrite_cannot_address_is_refused_before_decoding() {
        let never = |_: &[u8], _: bool, _: usize, _: usize| -> Result<Vec<u8>, RawError> { panic!("decoded a frame too large to rewrite") };
        // 70000 x 70000 at two bytes a sample is past what a LONG offset reaches.
        let huge = tiff_with(
            false,
            &[
                (WIDTH, 4, 70_000),
                (LENGTH, 4, 70_000),
                (BITS_PER_SAMPLE, 3, 16),
                (COMPRESSION, 3, VC5),
                (TILE_WIDTH, 4, 70_000),
                (TILE_LENGTH, 4, 70_000),
                (TILE_OFFSETS, 4, 0),
                (TILE_BYTE_COUNTS, 4, 3),
                (CFA_PATTERN, 1, 0x0001_0102),
            ],
            b"vc5",
        );
        assert!(as_dng_with(&huge, never).unwrap_err().to_string().contains("too large"));
    }
}
