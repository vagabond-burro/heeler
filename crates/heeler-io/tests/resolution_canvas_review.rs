use heeler_engine::ImageBuf;

#[test]
fn simple_webp_resolution_refuses_a_canvas_that_conflicts_with_its_pixels() {
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 1.0]);
    for (width, height) in [(30, 19), (31, 18), (32, 20)] {
        let mut file = heeler_io::encode_webp(&image, 90).unwrap();
        assert_eq!(&file[12..16], b"VP8 ");
        let before = file.clone();
        heeler_io::set_webp_dpi(&mut file, 240, width, height);
        let back = webp::Decoder::new(&file).decode().expect("DPI cannot make the existing picture unreadable");
        assert_eq!((back.width(), back.height()), (31, 19));
        assert_eq!(file, before, "A conflicting canvas request is ignored");
    }
}
