use heeler_engine::ImageBuf;

fn jpeg_case(kind: &str) {
    let image = ImageBuf::filled(31, 19, [0.3, 0.2, 0.1, 1.0]);
    let mut file = heeler_io::encode_jpeg(&image, 90).unwrap();
    heeler_io::set_jpeg_dpi(&mut file, 300);
    let original_pixels = heeler_io::decode_bytes(&file).unwrap().data;
    match kind {
        "comment" => { file.splice(2..2, *b"\xff\xfe\x00\x06note"); }
        "table" => {
            assert_eq!(&file[2..4], b"\xff\xe0");
            let end = 4 + u16::from_be_bytes([file[4], file[5]]) as usize;
            let app0: Vec<_> = file.drain(2..end).collect();
            let mut table = 2;
            while &file[table..table + 2] != b"\xff\xdb" {
                assert_eq!(file[table], 0xff);
                table += 2 + u16::from_be_bytes([file[table + 2], file[table + 3]]) as usize;
            }
            let after_table = table + 2 + u16::from_be_bytes([file[table + 2], file[table + 3]]) as usize;
            file.splice(after_table..after_table, app0);
        }
        "fill" => { file.insert(2, 0xff); }
        _ => unreachable!(),
    }
    let before_len = file.len();
    heeler_io::set_jpeg_dpi(&mut file, 240);
    if let Some(dir) = std::env::var_os("HEELER_DPI_JPEG_READER_DIR") {
        let dir = std::path::PathBuf::from(dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("jpeg-{kind}.jpg")), &file).unwrap();
    }
    assert_eq!(file.windows(5).filter(|w| *w == b"JFIF\0").count(), 1, "{kind}: patch the existing declaration");
    assert_eq!(file.len(), before_len, "{kind}: density does not add another APP0");
    let jfif = file.windows(5).position(|w| w == b"JFIF\0").unwrap();
    assert_eq!(file[jfif + 7], 1);
    assert_eq!(u16::from_be_bytes([file[jfif + 8], file[jfif + 9]]), 240);
    assert_eq!(u16::from_be_bytes([file[jfif + 10], file[jfif + 11]]), 240);
    assert_eq!(heeler_io::decode_bytes(&file).unwrap().data, original_pixels);
}

#[test]
fn jpeg_density_finds_jfif_after_a_comment() { jpeg_case("comment"); }

#[test]
fn jpeg_density_finds_jfif_after_a_quantization_table() { jpeg_case("table"); }

#[test]
fn jpeg_density_finds_jfif_after_marker_fill_bytes() { jpeg_case("fill"); }
