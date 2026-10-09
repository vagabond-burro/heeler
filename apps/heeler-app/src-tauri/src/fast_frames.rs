//! The viewer's frames through the faster JPEG encoder (2026-09-30: "do
//! the faster JPEG compressor for drag frames"): encode_preview_jpeg is
//! what render_preview_attempt and render_original send, so these tests
//! hold it to the frame the viewer used to get (size, pixels within DCT
//! rounding, the envelope the bridge parses) and to being faster.
use super::*;

/// A drag-sized frame with saturated color edges over smooth ramps.
fn frame(w: usize, h: usize) -> ImageBuf {
    let mut img = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let i = (y * w + x) * 4;
            let px = if ((x / 24) + (y / 24)) % 3 == 0 {
                [0.9, 0.02, 0.05, 1.0]
            } else if ((x / 24) + (y / 24)) % 3 == 1 {
                [0.02, 0.35, 0.9, 1.0]
            } else {
                [x as f32 / w as f32, 0.5, y as f32 / h as f32, 1.0]
            };
            img.data[i..i + 4].copy_from_slice(&px);
        }
    }
    img
}

/// A JPEG decoded back to its 8-bit codes: heeler_io reads it into the
/// linear working space, and the sRGB table takes it home again.
struct Rgb8 {
    width: usize,
    height: usize,
    data: Vec<u8>,
}
impl Rgb8 {
    fn dimensions(&self) -> (usize, usize) { (self.width, self.height) }
    fn as_raw(&self) -> &[u8] { &self.data }
}
fn rgb8(bytes: &[u8]) -> Rgb8 {
    let img = heeler_io::decode_bytes(bytes).unwrap();
    let data = img.data.chunks_exact(4).flat_map(|p| [heeler_io::srgb_u8(p[0]), heeler_io::srgb_u8(p[1]), heeler_io::srgb_u8(p[2])]).collect();
    Rgb8 { width: img.width, height: img.height, data }
}

/// What bridge.ts parsePreviewEnvelope does: magic, length, JSON, bytes.
fn split(env: &[u8]) -> (serde_json::Value, &[u8]) {
    assert_eq!(&env[0..4], b"HPRV");
    let len = u32::from_le_bytes(env[4..8].try_into().unwrap()) as usize;
    (serde_json::from_slice(&env[8..8 + len]).unwrap(), &env[8 + len..])
}

#[test]
fn a_gesture_frame_reaches_the_bridge_as_the_same_picture_the_old_encoder_sent() {
    let img = frame(1024, 683);
    let q = preview_jpeg_quality(false, None);
    let bytes = encode_preview_jpeg(&img, q).unwrap();
    let meta = PreviewResult {
        source_identity: None,
        memory_notice: None,
        mime: "image/jpeg".into(),
        ms: 3,
        image_id: "img_1".into(),
        backend: "gpu".into(),
        roi: None,
        frame: None,
    };
    let env = preview_envelope(&meta, &bytes).unwrap();
    let (json, image) = split(&env);
    assert_eq!(json["mime"], "image/jpeg", "the viewer wraps the bytes in a Blob of this type");
    assert_eq!(&image[..2], &[0xFF, 0xD8]);
    let got = rgb8(image);
    assert_eq!(got.dimensions(), (1024, 683));
    let old = rgb8(&heeler_io::encode_jpeg(&img, q).unwrap());
    let (mut sum, mut max) = (0u64, 0u8);
    for (a, b) in got.as_raw().iter().zip(old.as_raw()) {
        let d = a.abs_diff(*b);
        sum += d as u64;
        max = max.max(d);
    }
    let mean = sum as f64 / got.as_raw().len() as f64;
    assert!(mean < 1.0 && max <= 24, "against the old encoder: mean {mean:.3}, max {max}");
}

#[test]
fn every_settle_quality_step_keeps_its_quality() {
    let img = frame(640, 480);
    let src: Vec<u8> = img.data.chunks_exact(4).flat_map(|p| [heeler_io::srgb_u8(p[0]), heeler_io::srgb_u8(p[1]), heeler_io::srgb_u8(p[2])]).collect();
    let err = |bytes: &[u8]| rgb8(bytes).as_raw().iter().zip(&src).map(|(a, b)| a.abs_diff(*b) as f64).sum::<f64>() / src.len() as f64;
    let mut last = f64::INFINITY;
    for step in [75u8, 85, 94] {
        let q = preview_jpeg_quality(true, Some(step));
        let (new, old) = (err(&encode_preview_jpeg(&img, q).unwrap()), err(&heeler_io::encode_jpeg(&img, q).unwrap()));
        assert!(new <= old * 1.05 + 0.05, "q{q}: new {new:.3} against old {old:.3}");
        assert!(new < last, "a higher step must read closer to the source");
        last = new;
    }
}

#[test]
fn a_frame_libjpeg_refuses_still_goes_out_through_the_old_encoder() {
    // Wider than the fast path takes; the image crate's encoder writes
    // up to 65535.
    let img = ImageBuf::filled(65_510, 1, [0.2, 0.4, 0.6, 1.0]);
    assert!(heeler_io::encode_jpeg_fast(&img, 94).is_err());
    let bytes = encode_preview_jpeg(&img, 94).unwrap();
    assert_eq!(rgb8(&bytes).dimensions(), (65_510, 1));
}

/// A timing, so it runs on its own: in the full suite under a busy
/// machine (load 51 while a review ran, 2026-10-01) both encoders were
/// starved alike and the bar failed at 7.6 ms against 8.1 although the
/// encoder had not changed. The pictures the fast path sends are held by
/// the tests above on every run; run this one with
/// `cargo test -p heeler-desktop --lib fast_frames -- --ignored`.
#[test]
#[ignore = "timing; run alone with --ignored"]
fn a_drag_frame_encodes_faster_than_the_image_crate_did() {
    // The point of the change, held loosely. The two encoders run turn
    // about, nine times each, and the best of each is compared, so a busy
    // machine (the full suite runs many tests at once) slows both alike
    // rather than one: a first version timed five of one, then five of
    // the other, and once failed under load while passing alone. The bar
    // is the new path at most four fifths of the old; measured 3 ms
    // against 11 on the owner's Mac, and mozjpeg's scalar build (x64 with
    // no NASM) about 6 against 11.
    let img = frame(1024, 683);
    let time = |f: &dyn Fn() -> Vec<u8>| {
        let t = std::time::Instant::now();
        assert!(!f().is_empty());
        t.elapsed().as_secs_f64()
    };
    let (mut new, mut old) = (f64::INFINITY, f64::INFINITY);
    for _ in 0..9 {
        new = new.min(time(&|| encode_preview_jpeg(&img, 94).unwrap()));
        old = old.min(time(&|| heeler_io::encode_jpeg(&img, 94).unwrap()));
    }
    assert!(new <= old * 0.8, "new {:.1} ms against old {:.1} ms", new * 1e3, old * 1e3);
}
