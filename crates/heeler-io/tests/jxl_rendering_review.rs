//! A real compressed JPEG XL payload wrapped in a generated LinearRaw
//! DNG. The payload's source and license are in fixtures/review-jxl.
use heeler_engine::ImageBuf;

fn fixture(orientation: u16, gain: bool) -> Vec<u8> {
    let payload = include_bytes!("fixtures/review-jxl/traffic-light.jxl");
    let jxl = jxl_oxide::JxlImage::builder().read(&payload[..]).unwrap();
    let (w, h) = (jxl.width(), jxl.height());
    let mut fields: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
    for (tag, value) in [(254, 0), (256, w), (257, h), (258, 8), (259, 52546), (262, 34892), (274, orientation as u32), (277, 3), (278, h), (279, payload.len() as u32), (50717, 255)] {
        fields.push((tag, 4, 1, value.to_le_bytes().to_vec()));
    }
    fields.push((50706, 1, 4, vec![1, 7, 0, 0]));
    let forward = [0.436081f64, 0.385071, 0.143082, 0.222504, 0.716888, 0.060608, 0.013931, 0.097077, 0.713949];
    let rationals: Vec<u8> = forward.into_iter().flat_map(|v| {
        let mut bytes = ((v * 1_000_000.0).round() as i32).to_le_bytes().to_vec();
        bytes.extend(1_000_000i32.to_le_bytes()); bytes
    }).collect();
    fields.push((50964, 10, 9, rationals));
    if gain {
        let mut map = Vec::new();
        map.extend(1u32.to_le_bytes()); map.extend(2u32.to_le_bytes());
        for value in [1.0f64, 1.0, 0.0, 0.0] { map.extend(value.to_le_bytes()); }
        map.extend(2u32.to_le_bytes());
        for _ in 0..5 { map.extend(0f32.to_le_bytes()); }
        for value in [0.3f32, 0.3, 0.7, 0.7] { map.extend(value.to_le_bytes()); }
        fields.push((52525, 7, map.len() as u32, map));
        let mut exposure = 1i32.to_le_bytes().to_vec(); exposure.extend(1i32.to_le_bytes());
        fields.push((50730, 10, 1, exposure));
    }
    fields.push((273, 4, 1, vec![0; 4]));
    fields.sort_by_key(|f| f.0);
    let mut out = b"II\x2a\0\x08\0\0\0".to_vec();
    out.extend((fields.len() as u16).to_le_bytes());
    let values_at = 8 + 2 + fields.len() * 12 + 4;
    let extra_len: usize = fields.iter().filter(|f| f.3.len() > 4).map(|f| f.3.len()).sum();
    let payload_at = values_at + extra_len;
    let mut extra = Vec::new();
    for (tag, kind, count, data) in fields {
        out.extend(tag.to_le_bytes()); out.extend(kind.to_le_bytes()); out.extend(count.to_le_bytes());
        if tag == 273 { out.extend((payload_at as u32).to_le_bytes()); }
        else if data.len() <= 4 { let mut data = data; data.resize(4, 0); out.extend(data); }
        else { out.extend(((values_at + extra.len()) as u32).to_le_bytes()); extra.extend(data); }
    }
    out.extend(0u32.to_le_bytes()); out.extend(extra); out.extend(payload);
    out
}

fn expected(base: &ImageBuf, orientation: u16) -> image::ImageBuffer<image::Rgba<f32>, Vec<f32>> {
    let b = image::ImageBuffer::from_raw(base.width as u32, base.height as u32, base.data.clone()).unwrap();
    match orientation {
        2 => image::imageops::flip_horizontal(&b), 3 => image::imageops::rotate180(&b),
        4 => image::imageops::flip_vertical(&b), 5 => image::imageops::flip_horizontal(&image::imageops::rotate90(&b)),
        6 => image::imageops::rotate90(&b), 7 => image::imageops::flip_vertical(&image::imageops::rotate90(&b)),
        8 => image::imageops::rotate270(&b), _ => b,
    }
}

#[test]
fn a_compressed_linear_jxl_dng_is_upright_through_every_decode_path() {
    let base = heeler_io::decode_jxl_dng(&fixture(1, false)).unwrap();
    assert!(base.width > 1 && base.height > 1);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("review.DNG");
    for orientation in 1..=8 {
        let bytes = fixture(orientation, false);
        std::fs::write(&path, &bytes).unwrap();
        let oracle = expected(&base, orientation);
        let mut pictures = vec![heeler_io::decode_jxl_dng(&bytes).unwrap()];
        pictures.extend([
            heeler_io::decode_any(&path).unwrap(),
            heeler_io::decode_preview_at(&path, heeler_io::RawSourceOpts::default(), 2048).unwrap(),
            heeler_io::decode_thumbnail(&path).unwrap(),
        ]);
        for img in pictures {
            assert_eq!((img.width as u32, img.height as u32), oracle.dimensions());
            for (a, b) in img.data.iter().zip(oracle.as_raw()) { assert!((a - b).abs() < 1e-5); }
        }
    }
}

#[test]
fn a_gain_bearing_jxl_dng_renders_each_path_after_orientation() {
    let bytes = fixture(1, true);
    let mut base = heeler_io::decode_jxl_dng(&bytes).unwrap();
    let bare = base.clone();
    heeler_io::dng_gain::render(&mut base, &heeler_io::dng_gain::file_rendering(&bytes).unwrap());
    assert!(base.data.iter().zip(&bare.data).any(|(a,b)| (a-b).abs() > 0.01));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("mapped.DNG");
    for orientation in 1..=8 {
        std::fs::write(&path, fixture(orientation, true)).unwrap();
        let oracle = expected(&base, orientation);
        for img in [heeler_io::decode_any(&path).unwrap(), heeler_io::decode_preview_at(&path, Default::default(), 2048).unwrap(), heeler_io::decode_thumbnail(&path).unwrap()] {
            assert_eq!((img.width as u32, img.height as u32), oracle.dimensions());
            for (a,b) in img.data.iter().zip(oracle.as_raw()) { assert!((a-b).abs() < 1e-5, "orientation {orientation}: {a} != {b}"); }
        }
    }
}

/// A merge of exposures takes a phone DNG scene-linear (2026-10-03:
/// "stacks use scene-linear, panoramas keep phone rendering"): the
/// develop alone, without the file's baseline exposure, gain table map
/// and tone curve, at the full and the preview tier. A file with no
/// rendering of its own decodes the same either way.
#[test]
fn the_scene_linear_decodes_leave_a_gain_bearing_dng_unrendered() {
    let dir = tempfile::tempdir().unwrap();
    for orientation in [1u16, 6] {
        let bytes = fixture(orientation, true);
        let bare = heeler_io::decode_jxl_dng(&bytes).unwrap();
        let path = dir.path().join(format!("mapped-{orientation}.DNG"));
        std::fs::write(&path, &bytes).unwrap();
        let rendered = heeler_io::decode_any(&path).unwrap();
        assert_ne!(rendered.data, bare.data, "the fixture's map does change the picture");
        let full = heeler_io::decode_any_scene_linear(&path, Default::default()).unwrap();
        assert_eq!(full.data, bare.data, "orientation {orientation}");
        let tier = heeler_io::decode_preview_scene_linear_at(&path, Default::default(), 2048).unwrap();
        assert_eq!(tier.data, bare.data, "orientation {orientation}");
    }
    let plain = dir.path().join("plain.DNG");
    std::fs::write(&plain, fixture(1, false)).unwrap();
    assert_eq!(
        heeler_io::decode_any_scene_linear(&plain, Default::default()).unwrap().data,
        heeler_io::decode_any(&plain).unwrap().data,
    );
    assert_eq!(
        heeler_io::decode_preview_scene_linear_at(&plain, Default::default(), 2048).unwrap().data,
        heeler_io::decode_preview_at(&plain, Default::default(), 2048).unwrap().data,
    );
}
