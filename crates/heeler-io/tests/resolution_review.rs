use heeler_engine::ImageBuf;
use heeler_io::{set_jpeg_dpi, set_png_dpi, set_webp_dpi};

#[test]
fn truncated_jpeg_resolution_is_unchanged() {
    let jpeg_cases = [vec![0xff, 0xd8], b"\xff\xd8\xff\xe0\x00\x10JFIF\0".to_vec()];
    for mut bytes in jpeg_cases {
        let before = bytes.clone();
        set_jpeg_dpi(&mut bytes, 240);
        assert_eq!(bytes, before);
    }
}

#[test]
fn truncated_png_resolution_is_unchanged() {
    for kind in [b"IHDR", b"pHYs"] {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&u32::MAX.to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(&[0; 4]);
        let before = bytes.clone();
        set_png_dpi(&mut bytes, 240);
        assert_eq!(bytes, before);
    }
}

#[test]
fn truncated_webp_resolution_is_unchanged() {
    let mut bytes = b"RIFF\x14\0\0\0WEBPVP8L\xff\xff\xff\xff\x2f".to_vec();
    let before = bytes.clone();
    set_webp_dpi(&mut bytes, 240, 31, 19);
    assert_eq!(bytes, before);
}

#[test]
fn resolution_patchers_never_panic_on_truncated_encoded_headers() {
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 1.0]);
    for (file, patch) in [
        (heeler_io::encode_jpeg(&image, 90).unwrap(), set_jpeg_dpi as fn(&mut Vec<u8>, u32)),
        (heeler_io::encode_png16(&image).unwrap(), set_png_dpi),
    ] {
        for end in 0..file.len().min(100) {
            let mut prefix = file[..end].to_vec();
            patch(&mut prefix, 240);
        }
    }
}

#[test]
fn unrepresentable_webp_canvas_is_not_written() {
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 1.0]);
    for (w, h) in [(0, 19), (31, 0), (1 << 24 | 1, 19), (31, u32::MAX)] {
        let mut file = heeler_io::encode_webp(&image, 90).unwrap();
        let before = file.clone();
        set_webp_dpi(&mut file, 240, w, h);
        assert_eq!(file, before);
    }
}

fn chunks(file: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
    let mut at = 12;
    let mut result = Vec::new();
    while at < file.len() {
        let n = u32::from_le_bytes(file[at + 4..at + 8].try_into().unwrap()) as usize;
        result.push((file[at..at + 4].try_into().unwrap(), file[at + 8..at + 8 + n].to_vec()));
        at += 8 + n + (n & 1);
    }
    assert_eq!(at, file.len());
    result
}

#[test]
fn extended_webp_keeps_alpha_animation_padding_and_canvas() {
    for original in [
        include_bytes!("fixtures/dpi-alpha.webp").as_slice(),
        include_bytes!("fixtures/dpi-animated.webp").as_slice(),
        include_bytes!("fixtures/dpi-extended.webp").as_slice(),
    ] {
        let mut file = original.to_vec();
        // Unknown odd-sized chunks are legal and must retain their byte.
        file.extend_from_slice(b"test\x01\0\0\0x\0");
        let size = (file.len() - 8) as u32;
        file[4..8].copy_from_slice(&size.to_le_bytes());
        let before = chunks(&file);
        set_webp_dpi(&mut file, 240, 1, 1);
        let after = chunks(&file);
        assert_eq!(&before[0].1[1..], &after[0].1[1..], "existing canvas survives");
        assert_eq!(before[0].1[0] | 8, after[0].1[0]);
        assert_eq!(after.iter().filter(|c| c.0 == *b"EXIF").count(), 1);
        for c in before.iter().skip(1).filter(|c| c.0 != *b"EXIF") {
            assert!(after.contains(c), "image and auxiliary chunks survive");
        }
        assert_eq!(u32::from_le_bytes(file[4..8].try_into().unwrap()) as usize, file.len() - 8);
        let features = webp::BitstreamFeatures::new(&file).unwrap();
        assert_eq!((features.width(), features.height()), (31, 19));
        if features.has_animation() {
            assert_eq!(after.iter().filter(|c| c.0 == *b"ANMF").count(), 2);
        } else {
            let back = webp::Decoder::new(&file).decode().expect("libwebp reads the rewritten image");
            assert_eq!((back.width(), back.height()), (31, 19));
        }
    }
}

#[test]
fn simple_webp_canvas_and_pixels_survive_libwebp() {
    for alpha in [0.25, 1.0] {
        let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, alpha]);
        let mut file = heeler_io::encode_webp(&image, 90).unwrap();
        let before = webp::Decoder::new(&file).decode().unwrap();
        set_webp_dpi(&mut file, 240, 31, 19);
        let after = webp::Decoder::new(&file).decode().unwrap();
        assert_eq!(&before[..], &after[..]);
        let extended = &chunks(&file)[0].1;
        assert_eq!(&extended[4..7], &[30, 0, 0]);
        assert_eq!(&extended[7..10], &[18, 0, 0]);
    }
}

#[test]
fn jpeg_camera_resolution_agrees_with_jfif_when_metadata_is_kept() {
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 1.0]);
    let mut file = heeler_io::encode_jpeg(&image, 90).unwrap();
    let exif = heeler_io::write_exif_tiff(&heeler_io::Exif::default(), heeler_io::ExifExportOptions { width: 31, height: 19, dpi: 240 });
    heeler_io::embed_jpeg_exif(&mut file, &exif);
    heeler_io::embed_jpeg_xmp(&mut file, "<xmp/>");
    set_jpeg_dpi(&mut file, 240);
    let at = file.windows(5).position(|w| w == b"JFIF\0").unwrap();
    assert_eq!(file[at + 7], 1);
    assert_eq!(u16::from_be_bytes([file[at + 8], file[at + 9]]), 240);
    assert_eq!(u16::from_be_bytes([file[at + 10], file[at + 11]]), 240);
    assert!(file.windows(exif.len()).any(|w| w == exif), "camera record survives");
    assert_eq!(heeler_io::decode_bytes(&file).unwrap().width, 31);
}

#[test]
fn png_resolution_preserves_ancillary_chunks_and_replaces_existing_density() {
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 0.25]);
    fn png_chunks(bytes: &[u8]) -> Vec<([u8; 4], Vec<u8>)> {
        let mut at = 8;
        let mut out = Vec::new();
        while at < bytes.len() {
            let size = u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap()) as usize;
            out.push((bytes[at + 4..at + 8].try_into().unwrap(), bytes[at + 8..at + 8 + size].to_vec()));
            at += size + 12;
        }
        out
    }
    for mut bytes in [heeler_io::encode_png(&image).unwrap(), heeler_io::encode_png16(&image).unwrap()] {
        let exif = heeler_io::write_exif_tiff(&heeler_io::Exif::default(), heeler_io::ExifExportOptions { width: 31, height: 19, dpi: 240 });
        heeler_io::embed_png_exif(&mut bytes, &exif);
        heeler_io::embed_png_xmp(&mut bytes, "<xmp>PNG review keywords</xmp>");
        let before = png_chunks(&bytes);
        let pixels = heeler_io::decode_bytes(&bytes).unwrap().data;
        for dpi in [240, 150] {
            set_png_dpi(&mut bytes, dpi);
            let after = png_chunks(&bytes);
            assert_eq!(after.iter().filter(|(kind, _)| kind == b"pHYs").count(), 1);
            assert_eq!(after[0].0, *b"IHDR");
            assert_eq!(after[1].0, *b"pHYs");
            assert_eq!(after.iter().filter(|(kind, _)| kind != b"pHYs").cloned().collect::<Vec<_>>(), before);
            let body = &after[1].1;
            assert_eq!(u32::from_be_bytes(body[..4].try_into().unwrap()), (dpi as f64 / 0.0254).round() as u32);
            // The decoder checks chunk CRCs as well as the unchanged pixels.
            assert_eq!(heeler_io::decode_bytes(&bytes).unwrap().data, pixels);
        }
    }
}

#[test]
#[ignore = "Writes owned fixtures for external reader checks when HEELER_DPI_READER_DIR is set"]
fn write_resolution_reader_fixtures() {
    let path = std::path::PathBuf::from(std::env::var_os("HEELER_DPI_READER_DIR").expect("owned fixture directory"));
    std::fs::create_dir_all(&path).unwrap();
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 1.0]);
    for (name, mut bytes) in [
        ("jpeg.jpg", heeler_io::encode_jpeg(&image, 90).unwrap()),
        ("png.png", heeler_io::encode_png(&image).unwrap()),
        ("png16.png", heeler_io::encode_png16(&image).unwrap()),
        ("webp.webp", heeler_io::encode_webp(&image, 90).unwrap()),
        ("tiff16.tif", heeler_io::encode_tiff16_export(&image, heeler_io::TiffExportOptions { exif: None, xmp: None, dpi: 240 }).unwrap()),
        ("tiff32.tif", heeler_io::encode_tiff32f(&image, heeler_io::FloatTiffOptions { include_alpha: false, dpi: Some(240) }).unwrap()),
    ] {
        match name {
            "jpeg.jpg" => set_jpeg_dpi(&mut bytes, 240),
            "png.png" | "png16.png" => set_png_dpi(&mut bytes, 240),
            "webp.webp" => set_webp_dpi(&mut bytes, 240, 31, 19),
            _ => {},
        }
        std::fs::write(path.join(name), bytes).unwrap();
    }
    let mut png = heeler_io::encode_png(&image).unwrap();
    let png_exif = heeler_io::write_exif_tiff(&heeler_io::Exif::default(), heeler_io::ExifExportOptions { width: 31, height: 19, dpi: 240 });
    heeler_io::embed_png_exif(&mut png, &png_exif);
    heeler_io::embed_png_xmp(&mut png, "<xmp>PNG review keywords</xmp>");
    set_png_dpi(&mut png, 240);
    std::fs::write(path.join("png-metadata.png"), png).unwrap();
    let mut jpeg = heeler_io::encode_jpeg(&image, 90).unwrap();
    let exif = heeler_io::write_exif_tiff(&heeler_io::Exif::default(), heeler_io::ExifExportOptions { width: 31, height: 19, dpi: 240 });
    heeler_io::embed_jpeg_exif(&mut jpeg, &exif);
    heeler_io::embed_jpeg_xmp(&mut jpeg, "<xmp/>");
    set_jpeg_dpi(&mut jpeg, 240);
    std::fs::write(path.join("jpeg-metadata.jpg"), jpeg).unwrap();
    for (name, original) in [("alpha.webp", include_bytes!("fixtures/dpi-alpha.webp").as_slice()), ("animated.webp", include_bytes!("fixtures/dpi-animated.webp").as_slice()), ("extended.webp", include_bytes!("fixtures/dpi-extended.webp").as_slice())] {
        let mut bytes = original.to_vec();
        set_webp_dpi(&mut bytes, 240, 31, 19);
        std::fs::write(path.join(name), bytes).unwrap();
    }
}
