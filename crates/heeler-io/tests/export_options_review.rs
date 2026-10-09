use std::io::Cursor;
use heeler_engine::ImageBuf;
use heeler_io::*;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

fn resolution(bytes: &[u8], expected: u32) {
    let mut decoder = Decoder::new(Cursor::new(bytes)).unwrap();
    assert_eq!(decoder.dimensions().unwrap(), (5, 3));
    for tag in [Tag::XResolution, Tag::YResolution] {
        assert_eq!(decoder.get_tag(tag).unwrap(), tiff::decoder::ifd::Value::Rational(expected, 1));
    }
    assert_eq!(decoder.get_tag_unsigned::<u16>(Tag::ResolutionUnit).unwrap(), 2);
}

#[test]
fn tiff_export_options_keep_metadata_resolution_and_pixels() {
    let source = ImageBuf::filled(5, 3, [0.3, 0.2, 0.1, 0.25]);
    let exif = Exif { make: Some("Review camera".into()), artist: Some("Review artist".into()), ..Default::default() };
    let xmp = "<xmp>Review keywords</xmp>";
    for (bytes, dpi, metadata, keywords) in [
        (encode_tiff16_export(&source, heeler_io::TiffExportOptions { exif: None, ..Default::default() }).unwrap(), 300, false, false),
        (encode_tiff16_export(&source, heeler_io::TiffExportOptions { exif: Some(&exif), ..Default::default() }).unwrap(), 300, true, false),
        (encode_tiff16_export(&source, heeler_io::TiffExportOptions { exif: Some(&exif), xmp: Some(xmp), ..Default::default() }).unwrap(), 300, true, true),
        (encode_tiff16_export(&source, heeler_io::TiffExportOptions { exif: Some(&exif), xmp: Some(xmp), dpi: 240 }).unwrap(), 240, true, true),
    ] {
        resolution(&bytes, dpi);
        let read = read_exif(&bytes);
        assert_eq!(read.make.is_some(), metadata);
        assert_eq!(read.artist.is_some(), metadata);
        assert_eq!(bytes.windows(xmp.len()).any(|w| w == xmp.as_bytes()), keywords);
        let decoded = decode_bytes(&bytes).unwrap();
        assert!((decoded.data[3] - 0.25).abs() < 0.0001);
        assert!((decoded.data[0] - 0.3).abs() < 0.001);
    }
}

#[test]
fn float_tiff_print_resolution_does_not_change_linear_samples() {
    let source = ImageBuf::filled(5, 3, [2.5, -0.1, 0.3, 0.25]);
    for alpha in [false, true] {
        let raw = encode_tiff32f(&source, heeler_io::FloatTiffOptions { include_alpha: alpha, dpi: None }).unwrap();
        let export = encode_tiff32f(&source, heeler_io::FloatTiffOptions { include_alpha: alpha, dpi: Some(240) }).unwrap();
        resolution(&export, 240);
        let mut untagged = Decoder::new(Cursor::new(&raw)).unwrap();
        assert!(untagged.get_tag(Tag::XResolution).is_err());
        let mut tagged = Decoder::new(Cursor::new(&export)).unwrap();
        let DecodingResult::F32(before) = untagged.read_image().unwrap() else { panic!("float samples") };
        let DecodingResult::F32(after) = tagged.read_image().unwrap() else { panic!("float samples") };
        assert_eq!(before, after);
        assert_eq!(&after[..3], &[2.5, -0.1, 0.3]);
        assert_eq!(after.len(), 5 * 3 * if alpha { 4 } else { 3 });
    }
}

#[test]
fn exif_export_keeps_dimensions_camera_and_default_resolution() {
    let exif = Exif { make: Some("Review camera".into()), orientation: Some(6), ..Default::default() };
    for (bytes, dpi) in [
        (write_exif_tiff(&exif, heeler_io::ExifExportOptions { width: 5, height: 3, dpi: heeler_io::DEFAULT_DPI }), 300),
        (write_exif_tiff(&exif, heeler_io::ExifExportOptions { width: 5, height: 3, dpi: 240 }), 240),
    ] {
        let at = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize;
        let values: Vec<_> = (0..count).filter_map(|i| {
            let entry = &bytes[at + 2 + i * 12..at + 14 + i * 12];
            if ![282, 283].contains(&u16::from_le_bytes(entry[..2].try_into().unwrap())) { return None; }
            let offset = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
            Some(u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()))
        }).collect();
        assert_eq!(values, vec![dpi, dpi]);
        let back = read_exif(&bytes);
        assert_eq!(back.make.as_deref(), Some("Review camera"));
        assert_eq!(back.orientation, Some(1));
    }
}
