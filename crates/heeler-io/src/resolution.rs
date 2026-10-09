//! The print resolution an exported file declares.
//!
//! A pixel has no size until a file says how many go to an inch, and a
//! print shop, a layout program or a photo lab reads that number to size
//! the picture on paper. Exports carried it unevenly (2026-10-06: "I
//! think we are missing DPI settings for exports"): the 16-bit TIFF
//! always said 300, a JPEG or PNG said 300 only inside the camera's EXIF
//! when metadata was kept and the source had any, the bare JPEG's JFIF
//! header otherwise read as 1 dpi, and PNG, WebP and the float TIFF said
//! nothing. Now the export's setting goes into JPEG, PNG, WebP and both
//! TIFF exports, metadata kept or not: it describes the print, not the
//! person.
//!
//! Nothing here touches pixels. The same file prints at 8 by 10 inches
//! at 300 or at 20 by 25 at 120; only the declaration changes.

// Generated from the same JSON contract the frontend imports.
include!(concat!(env!("OUT_DIR"), "/export_resolution.rs"));

/// A requested resolution as a container can store it.
pub fn clamp_dpi(dpi: u32) -> u32 {
    dpi.clamp(1, MAX_DPI)
}

/// Numeric scripting input follows the same contract as the UI.
/// JSON cannot represent NaN or infinity; non-finite callers get the default.
pub fn normalize_dpi(dpi: Option<f64>) -> u32 {
    dpi.filter(|v| v.is_finite())
        .unwrap_or(DEFAULT_DPI as f64)
        .round().clamp(1.0, MAX_DPI as f64) as u32
}

/// Writes `dpi` into a JPEG's JFIF header, patching the encoder's APP0
/// when there is one and inserting one right after SOI when there is
/// not. The encoder's default density is unit 0 (an aspect ratio), which
/// readers report as 1 dpi. No-op on anything that is not a JPEG.
pub fn set_jpeg_dpi(jpeg: &mut Vec<u8>, dpi: u32) {
    if jpeg.len() < 4 || jpeg.get(0..2) != Some(&[0xFF, 0xD8][..]) {
        return;
    }
    let d = (clamp_dpi(dpi) as u16).to_be_bytes();
    // A comment, table or fill byte can precede JFIF. A second APP0 can
    // make readers keep the old density instead of the requested one.
    let mut at = 2usize;
    while at + 2 <= jpeg.len() && jpeg[at] == 0xFF {
        while at + 1 < jpeg.len() && jpeg[at + 1] == 0xFF { at += 1; }
        if at + 2 > jpeg.len() { return; }
        let marker = jpeg[at + 1];
        if matches!(marker, 0xD9 | 0xDA) { break; }
        if matches!(marker, 0x00 | 0xD8) { return; }
        if matches!(marker, 0x01 | 0xD0..=0xD7) { at += 2; continue; }
        if at + 4 > jpeg.len() { return; }
        let len = u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]) as usize;
        if len < 2 || at.checked_add(2 + len).is_none_or(|end| end > jpeg.len()) {
            return;
        }
        if marker == 0xE0 && len >= 16 && jpeg.get(at + 4..at + 9) == Some(&b"JFIF\0"[..]) {
            // units, Xdensity, Ydensity follow the identifier and version.
            jpeg[at + 11] = 1;
            jpeg[at + 12..at + 14].copy_from_slice(&d);
            jpeg[at + 14..at + 16].copy_from_slice(&d);
            return;
        }
        at += 2 + len;
    }
    let mut app0 = vec![0xFF, 0xE0, 0x00, 0x10];
    app0.extend_from_slice(b"JFIF\0");
    app0.extend_from_slice(&[1, 2, 1]); // version 1.02, units: dots per inch
    app0.extend_from_slice(&d);
    app0.extend_from_slice(&d);
    app0.extend_from_slice(&[0, 0]); // no thumbnail
    jpeg.splice(2..2, app0);
}

/// Writes `dpi` into a PNG as its pHYs chunk (pixels per meter, the only
/// unit PNG has), right after IHDR, where it must precede the image
/// data. An existing pHYs is replaced. No-op on anything that is not a
/// PNG.
pub fn set_png_dpi(png: &mut Vec<u8>, dpi: u32) {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    if png.get(0..8) != Some(&SIG[..]) {
        return;
    }
    let ppm = (clamp_dpi(dpi) as f64 / 0.0254).round() as u32;
    let mut body = Vec::with_capacity(9);
    body.extend_from_slice(&ppm.to_be_bytes());
    body.extend_from_slice(&ppm.to_be_bytes());
    body.push(1); // unit: the meter
    let mut chunk = Vec::with_capacity(21);
    chunk.extend_from_slice(&9u32.to_be_bytes());
    chunk.extend_from_slice(b"pHYs");
    chunk.extend_from_slice(&body);
    let crc = crate::exif::png_crc(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());
    let mut at = 8usize;
    let mut after_ihdr = None;
    while at + 12 <= png.len() {
        let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
        let Some(end) = at.checked_add(12).and_then(|n| n.checked_add(len)).filter(|end| *end <= png.len()) else {
            return;
        };
        match &png[at + 4..at + 8] {
            b"IHDR" if len == 13 => after_ihdr = Some(end),
            b"IHDR" => return,
            b"pHYs" if len == 9 => {
                png.splice(at..end, chunk);
                return;
            }
            b"pHYs" => return,
            b"IDAT" | b"IEND" => break,
            _ => {}
        }
        at = end;
    }
    if let Some(at) = after_ihdr {
        png.splice(at..at, chunk);
    }
}

/// Writes `dpi` into a WebP as an EXIF chunk holding only the
/// resolution. WebP has no resolution field of its own; EXIF is where
/// the format's readers look. A simple file (one VP8 or VP8L chunk) is
/// turned into the extended form the EXIF chunk needs, its canvas taken
/// from `width` and `height`, checked against the encoded picture, and its
/// alpha flag from the lossless
/// header. An existing EXIF chunk is replaced. No-op on anything that is
/// not a WebP.
pub fn set_webp_dpi(webp: &mut Vec<u8>, dpi: u32, width: u32, height: u32) {
    if webp.len() < 20 || &webp[0..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
        return;
    }
    // Reject truncated containers and dimensions the 24-bit canvas cannot
    // represent before assembling a replacement file.
    let riff_size = u32::from_le_bytes(webp[4..8].try_into().unwrap()) as usize;
    if riff_size.checked_add(8) != Some(webp.len()) || width == 0 || height == 0 || width > 1 << 24 || height > 1 << 24 {
        return;
    }
    // The chunks after the header, EXIF dropped (one is written below).
    let mut chunks: Vec<(&[u8], &[u8])> = Vec::new();
    let mut at = 12usize;
    while at + 8 <= webp.len() {
        let len = u32::from_le_bytes(webp[at + 4..at + 8].try_into().unwrap()) as usize;
        let Some(body_end) = at.checked_add(8).and_then(|n| n.checked_add(len)).filter(|end| *end <= webp.len()) else {
            return;
        };
        let Some(next) = body_end.checked_add(len & 1).filter(|end| *end <= webp.len()) else {
            return;
        };
        let fourcc = &webp[at..at + 4];
        if fourcc != b"EXIF" {
            chunks.push((fourcc, &webp[at + 8..body_end]));
        }
        at = next;
    }
    if at != webp.len() || chunks.iter().enumerate().any(|(i, (f, b))| *f == b"VP8X" && (i != 0 || b.len() != 10)) {
        return;
    }
    // A density-only change cannot invent a canvas that conflicts with
    // the encoded picture. Read features without decoding pixels.
    if !matches!(chunks.first(), Some((f, _)) if *f == b"VP8X") {
        let Some(features) = webp::BitstreamFeatures::new(webp) else { return; };
        if (features.width(), features.height()) != (width, height) { return; }
    }
    let exif = crate::exif::resolution_exif_tiff(clamp_dpi(dpi));
    let mut out = Vec::with_capacity(webp.len() + exif.len() + 32);
    out.extend_from_slice(b"RIFF\0\0\0\0WEBP");
    let push = |out: &mut Vec<u8>, fourcc: &[u8], body: &[u8]| {
        out.extend_from_slice(fourcc);
        out.extend_from_slice(&(body.len() as u32).to_le_bytes());
        out.extend_from_slice(body);
        if body.len() & 1 == 1 {
            out.push(0);
        }
    };
    const EXIF_FLAG: u8 = 0x08;
    const ALPHA_FLAG: u8 = 0x10;
    match chunks.first() {
        Some((b"VP8X", body)) if body.len() >= 10 => {
            let mut vp8x = body.to_vec();
            vp8x[0] |= EXIF_FLAG;
            push(&mut out, b"VP8X", &vp8x);
            for (fourcc, body) in &chunks[1..] {
                push(&mut out, fourcc, body);
            }
        }
        _ => {
            // A lossless bitstream says whether it uses alpha in bit 28
            // of the word after its signature byte.
            let alpha = chunks.iter().any(|(f, b)| *f == b"VP8L" && b.len() >= 5 && b[4] & 0x10 != 0);
            let (w, h) = (width.max(1) - 1, height.max(1) - 1);
            let mut vp8x = vec![EXIF_FLAG | if alpha { ALPHA_FLAG } else { 0 }, 0, 0, 0];
            vp8x.extend_from_slice(&w.to_le_bytes()[..3]);
            vp8x.extend_from_slice(&h.to_le_bytes()[..3]);
            push(&mut out, b"VP8X", &vp8x);
            for (fourcc, body) in &chunks {
                push(&mut out, fourcc, body);
            }
        }
    }
    push(&mut out, b"EXIF", &exif);
    let riff = (out.len() - 8) as u32;
    out[4..8].copy_from_slice(&riff.to_le_bytes());
    *webp = out;
}

#[cfg(test)]
mod tests {
    use super::*;
    use heeler_engine::ImageBuf;

    fn picture() -> ImageBuf {
        let mut img = ImageBuf::new(24, 16);
        for (i, v) in img.data.iter_mut().enumerate() {
            *v = if i % 4 == 3 { 1.0 } else { (i % 7) as f32 / 7.0 };
        }
        img
    }

    /// The JFIF density a JPEG declares: (units, x, y).
    fn jfif(jpeg: &[u8]) -> Option<(u8, u16, u16)> {
        let mut at = 2;
        while at + 4 <= jpeg.len() && jpeg[at] == 0xFF && (0xE0..=0xEF).contains(&jpeg[at + 1]) {
            let len = u16::from_be_bytes([jpeg[at + 2], jpeg[at + 3]]) as usize;
            if jpeg[at + 1] == 0xE0 && &jpeg[at + 4..at + 9] == b"JFIF\0" {
                return Some((jpeg[at + 11], u16::from_be_bytes([jpeg[at + 12], jpeg[at + 13]]), u16::from_be_bytes([jpeg[at + 14], jpeg[at + 15]])));
            }
            at += 2 + len;
        }
        None
    }

    #[test]
    fn a_jpeg_declares_its_dpi_and_still_decodes() {
        let mut jpeg = crate::encode_jpeg(&picture(), 90).unwrap();
        set_jpeg_dpi(&mut jpeg, 240);
        assert_eq!(jfif(&jpeg), Some((1, 240, 240)));
        assert_eq!(crate::decode_bytes(&jpeg).unwrap().width, 24);
        // Again, after the EXIF splice puts an APP1 ahead of the APP0:
        // the same header is patched, not a second one added.
        crate::embed_jpeg_exif(&mut jpeg, &crate::write_exif_tiff(&crate::Exif::default(), crate::ExifExportOptions { width: 24, height: 16, dpi: crate::DEFAULT_DPI }));
        set_jpeg_dpi(&mut jpeg, 300);
        assert_eq!(jfif(&jpeg), Some((1, 300, 300)));
        assert_eq!(jpeg.windows(5).filter(|w| *w == b"JFIF\0").count(), 1);
        assert_eq!(crate::decode_bytes(&jpeg).unwrap().height, 16);
    }

    #[test]
    fn a_jpeg_with_no_jfif_header_gets_one() {
        let mut jpeg = crate::encode_jpeg(&picture(), 90).unwrap();
        // Strip the APP0 the encoder wrote.
        let len = u16::from_be_bytes([jpeg[4], jpeg[5]]) as usize;
        if jpeg[3] == 0xE0 {
            jpeg.drain(2..4 + len);
        }
        assert_eq!(jfif(&jpeg), None);
        set_jpeg_dpi(&mut jpeg, 300);
        assert_eq!(jfif(&jpeg), Some((1, 300, 300)));
        assert_eq!(crate::decode_bytes(&jpeg).unwrap().width, 24);
    }

    /// pHYs as written: (x, y, unit).
    fn phys(png: &[u8]) -> Vec<(u32, u32, u8)> {
        let mut out = Vec::new();
        let mut at = 8;
        while at + 12 <= png.len() {
            let len = u32::from_be_bytes(png[at..at + 4].try_into().unwrap()) as usize;
            if &png[at + 4..at + 8] == b"pHYs" {
                let b = &png[at + 8..at + 17];
                out.push((u32::from_be_bytes(b[0..4].try_into().unwrap()), u32::from_be_bytes(b[4..8].try_into().unwrap()), b[8]));
            }
            at += 12 + len;
        }
        out
    }

    #[test]
    fn a_png_declares_its_dpi_once_before_its_pixels() {
        for mut png in [crate::encode_png(&picture()).unwrap(), crate::encode_png16(&picture()).unwrap()] {
            set_png_dpi(&mut png, 300);
            set_png_dpi(&mut png, 300);
            assert_eq!(phys(&png), vec![(11811, 11811, 1)], "300 dpi is 11811 pixels a meter, once");
            let phys_at = png.windows(4).position(|w| w == b"pHYs").unwrap();
            let idat_at = png.windows(4).position(|w| w == b"IDAT").unwrap();
            assert!(phys_at < idat_at);
            // image's decoder checks every chunk's CRC.
            assert_eq!(crate::decode_bytes(&png).unwrap().width, 24);
            set_png_dpi(&mut png, 72);
            assert_eq!(phys(&png), vec![(2835, 2835, 1)]);
        }
    }

    /// The resolution an EXIF TIFF stream declares: (x, y, unit).
    fn exif_resolution(tiff: &[u8]) -> (u32, u32, u16) {
        let ifd = u32::from_le_bytes(tiff[4..8].try_into().unwrap()) as usize;
        let n = u16::from_le_bytes(tiff[ifd..ifd + 2].try_into().unwrap()) as usize;
        let (mut x, mut y, mut unit) = (0, 0, 0);
        for i in 0..n {
            let e = &tiff[ifd + 2 + i * 12..ifd + 14 + i * 12];
            let tag = u16::from_le_bytes([e[0], e[1]]);
            let off = u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize;
            let ratio = || u32::from_le_bytes(tiff[off..off + 4].try_into().unwrap()) / u32::from_le_bytes(tiff[off + 4..off + 8].try_into().unwrap());
            match tag {
                0x011a => x = ratio(),
                0x011b => y = ratio(),
                0x0128 => unit = u16::from_le_bytes([e[8], e[9]]),
                _ => {}
            }
        }
        (x, y, unit)
    }

    fn webp_chunks(webp: &[u8]) -> Vec<(String, Vec<u8>)> {
        let mut out = Vec::new();
        let mut at = 12;
        while at + 8 <= webp.len() {
            let len = u32::from_le_bytes(webp[at + 4..at + 8].try_into().unwrap()) as usize;
            out.push((String::from_utf8_lossy(&webp[at..at + 4]).into_owned(), webp[at + 8..at + 8 + len].to_vec()));
            at += 8 + len + (len & 1);
        }
        out
    }

    #[test]
    fn a_webp_declares_its_dpi_in_exif_and_still_decodes() {
        let mut opaque = picture();
        let mut clear = picture();
        clear.data[3] = 0.25;
        for img in [&mut opaque, &mut clear] {
            let mut webp = crate::encode_webp(img, 90).unwrap();
            set_webp_dpi(&mut webp, 300, 24, 16);
            set_webp_dpi(&mut webp, 300, 24, 16);
            let chunks = webp_chunks(&webp);
            assert_eq!(chunks[0].0, "VP8X");
            assert_ne!(chunks[0].1[0] & 0x08, 0, "the EXIF flag is set");
            let exif: Vec<_> = chunks.iter().filter(|c| c.0 == "EXIF").collect();
            assert_eq!(exif.len(), 1, "one EXIF chunk, however often it is set");
            assert_eq!(exif_resolution(&exif[0].1), (300, 300, 2));
            assert_eq!(u32::from_le_bytes(webp[4..8].try_into().unwrap()) as usize, webp.len() - 8, "the RIFF size covers the file");
            let back = image::load_from_memory(&webp).unwrap();
            assert_eq!((back.width(), back.height()), (24, 16));
        }
    }

    /// IFD0's resolution in a little-endian TIFF: (x, y, unit), None for
    /// a tag that is absent.
    fn tiff_resolution(tiff: &[u8]) -> (Option<u32>, Option<u32>, Option<u16>) {
        assert_eq!(&tiff[0..2], b"II");
        let ifd = u32::from_le_bytes(tiff[4..8].try_into().unwrap()) as usize;
        let n = u16::from_le_bytes(tiff[ifd..ifd + 2].try_into().unwrap()) as usize;
        let (mut x, mut y, mut unit) = (None, None, None);
        for i in 0..n {
            let e = &tiff[ifd + 2 + i * 12..ifd + 14 + i * 12];
            let off = u32::from_le_bytes(e[8..12].try_into().unwrap()) as usize;
            let ratio = || u32::from_le_bytes(tiff[off..off + 4].try_into().unwrap()) / u32::from_le_bytes(tiff[off + 4..off + 8].try_into().unwrap());
            match u16::from_le_bytes([e[0], e[1]]) {
                282 => x = Some(ratio()),
                283 => y = Some(ratio()),
                296 => unit = Some(u16::from_le_bytes([e[8], e[9]])),
                _ => {}
            }
        }
        (x, y, unit)
    }

    #[test]
    fn both_tiff_exports_declare_the_dpi_they_are_given() {
        let img = picture();
        let t16 = crate::encode_tiff16_export(&img, crate::TiffExportOptions { exif: None, xmp: None, dpi: 240 }).unwrap();
        assert_eq!(tiff_resolution(&t16), (Some(240), Some(240), Some(2)));
        let t32 = crate::encode_tiff32f(&img, crate::FloatTiffOptions { include_alpha: false, dpi: Some(240) }).unwrap();
        assert_eq!(tiff_resolution(&t32), (Some(240), Some(240), Some(2)));
        // The forms that take no setting keep what they wrote before:
        // the 16-bit export its 300, the float bake nothing.
        assert_eq!(tiff_resolution(&crate::encode_tiff16_export(&img, crate::TiffExportOptions { exif: None, xmp: None, ..Default::default() }).unwrap()), (Some(300), Some(300), Some(2)));
        assert_eq!(tiff_resolution(&crate::encode_tiff32f(&img, crate::FloatTiffOptions { include_alpha: false, dpi: None }).unwrap()), (None, None, None));
        for file in [t16, t32] {
            assert_eq!(crate::decode_bytes(&file).unwrap().width, 24);
        }
    }

    #[test]
    fn a_camera_record_declares_the_exports_dpi() {
        let tiff = crate::write_exif_tiff(&crate::Exif::default(), crate::ExifExportOptions { width: 24, height: 16, dpi: 240 });
        assert_eq!(exif_resolution(&tiff), (240, 240, 2));
        assert_eq!(exif_resolution(&crate::write_exif_tiff(&crate::Exif::default(), crate::ExifExportOptions { width: 24, height: 16, dpi: crate::DEFAULT_DPI })), (300, 300, 2));
    }

    #[test]
    fn the_dpi_is_kept_inside_what_every_container_stores() {
        assert_eq!(clamp_dpi(0), 1);
        assert_eq!(clamp_dpi(300), 300);
        assert_eq!(clamp_dpi(1_000_000), MAX_DPI);
        let mut jpeg = crate::encode_jpeg(&picture(), 90).unwrap();
        set_jpeg_dpi(&mut jpeg, 1_000_000);
        assert_eq!(jfif(&jpeg), Some((1, 65_535, 65_535)));
    }

    #[test]
    fn other_bytes_are_left_alone() {
        for f in [set_jpeg_dpi as fn(&mut Vec<u8>, u32), set_png_dpi] {
            let mut junk = b"not an image at all".to_vec();
            f(&mut junk, 300);
            assert_eq!(junk, b"not an image at all");
        }
        let mut junk = b"not an image at all".to_vec();
        set_webp_dpi(&mut junk, 300, 1, 1);
        assert_eq!(junk, b"not an image at all");
    }
}
