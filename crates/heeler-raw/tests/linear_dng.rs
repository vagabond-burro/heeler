//! heeler-raw's own develop of a linear DNG in lossless JPEG tiles is
//! LibRaw's develop of the whole file, to the bit, on Apple's arm64
//! build, whose float arithmetic linear_dng.rs reproduces (the order
//! clang fuses its multiply-adds in). A small DNG made here, upright and
//! turned, with highlights clipped past white so Blend has work, under
//! Clip and Blend, in bands of every height. A new toolchain that fused
//! LibRaw's sums another way would fail here before any photograph
//! changed: the app then develops these files with LibRaw again.
use heeler_raw::linear_dng::{synthetic_dng, LinearDng};
use heeler_raw::DevelopOpts;

fn pixel(y: usize, x: usize) -> [u16; 3] {
    // A gradient and texture, a few colors, and a blown patch.
    let n = ((x as u32).wrapping_mul(2_654_435_761) ^ (y as u32).wrapping_mul(2_246_822_519)) >> 22;
    if (40..60).contains(&x) && (30..50).contains(&y) {
        return [1023, 1023 - (n & 7) as u16, 1010];
    }
    let base = (x * 7 + y * 3) as u32 % 900;
    [(base + n % 60).min(1023) as u16, (base / 2 + n % 40) as u16, ((900 - base) + n % 50).min(1023) as u16]
}

#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn a_linear_dngs_rows_are_libraws_develop_to_the_bit() {
    // With the rust-decoder feature the module reads the file's facts in
    // Rust (rust_facts), held here to LibRaw's develop with LibRaw's color.
    #[cfg(feature = "rust-decoder")]
    heeler_raw::rust_path::set_libraw_color(true);
    for orientation in [1u16, 6, 8, 3] {
        let bytes = synthetic_dng(150, 101, 64, 48, orientation, pixel);
        for highlight in [0, 2] {
            let opts = DevelopOpts { highlight, ..DevelopOpts::default() };
            assert_eq!(heeler_raw::linear_dng::declined_because(&bytes, opts).unwrap(), None, "orientation {orientation}");
            let dng = LinearDng::open(bytes.clone(), opts).unwrap().expect("this module's file");
            let n = dng.numbers(dng.data_maximum().unwrap(), highlight);
            let whole = heeler_raw::decode_sensor_with(&bytes, opts).unwrap();
            let (w, h) = dng.size();
            assert_eq!((whole.width, whole.height), (w, h), "orientation {orientation}");
            for band in [1usize, 7, 48, h] {
                let mut rows = Vec::new();
                for y in (0..h).step_by(band) {
                    rows.extend(dng.rows(&n, y, (y + band).min(h)).unwrap());
                }
                let first = rows.iter().zip(&whole.rgb).position(|(a, b)| a != b);
                assert!(first.is_none(), "orientation {orientation}, highlight {highlight}, bands of {band}: differs first at sample {first:?}");
            }
        }
    }
}

#[test]
fn the_synthetic_file_has_highlights_for_blend_to_rebuild() {
    let bytes = synthetic_dng(150, 101, 64, 48, 1, pixel);
    let clip = heeler_raw::decode_sensor_with(&bytes, DevelopOpts { highlight: 0, ..DevelopOpts::default() }).unwrap();
    let blend = heeler_raw::decode_sensor_with(&bytes, DevelopOpts { highlight: 2, ..DevelopOpts::default() }).unwrap();
    let at = (40 * 150 + 50) * 3;
    assert_ne!(clip.rgb[at..at + 3], blend.rgb[at..at + 3], "the blown patch differs under Blend");
    let white = clip.rgb.chunks_exact(3).filter(|p| p.iter().max().copied().unwrap_or(0) >= (0.98 * 65535.0) as u16).count();
    assert!(white >= 64, "enough at white for the kept Blend develop: {white}");
}

#[test]
fn a_file_outside_the_module_is_declined() {
    // The repository's CR2 is a mosaic: LibRaw's.
    let cr2 = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/IMG_3310.CR2")).unwrap();
    assert!(heeler_raw::linear_dng::declined_because(&cr2, DevelopOpts::default()).unwrap().is_some());
    assert!(LinearDng::open(cr2, DevelopOpts::default()).unwrap().is_none());
    // A highlight rebuild is LibRaw's too.
    let dng = synthetic_dng(64, 48, 32, 24, 1, pixel);
    assert_eq!(heeler_raw::linear_dng::declined_because(&dng, DevelopOpts { highlight: 5, ..DevelopOpts::default() }).unwrap(), Some("a highlight rebuild"));
}

#[test]
fn damaged_tile_headers_and_entropy_return_errors() {
    let original = synthetic_dng(150, 101, 64, 48, 1, pixel);
    let start = original.windows(2).position(|p| p == [255, 216]).unwrap();
    for tag in [0xc3, 0xda, 0xdd] {
        let mut bytes = original.clone();
        let at = if tag == 0xdd { start + 2 } else {
            start + bytes[start..].windows(2).position(|p| p == [255, tag]).unwrap()
        };
        bytes[at + 1] = tag;
        bytes[at + 2..at + 4].copy_from_slice(&2u16.to_be_bytes());
        let dng = LinearDng::open(bytes, DevelopOpts::default()).unwrap().unwrap();
        assert!(dng.tile(0).is_err(), "short {tag:x} segment");
    }
    let dht = start + original[start..].windows(2).position(|p| p == [255, 196]).unwrap();
    for bad in [17, 32, 255] {
        let mut bytes = original.clone();
        let len = u16::from_be_bytes([bytes[dht + 2], bytes[dht + 3]]) as usize;
        bytes[dht + 21..dht + 2 + len].fill(bad);
        let dng = LinearDng::open(bytes, DevelopOpts::default()).unwrap().unwrap();
        assert!(dng.tile(0).is_err(), "Huffman category {bad}");
    }
    // Keep the directory and tile intact but end its declared byte span
    // immediately after SOS, before any entropy bits are available.
    let mut bytes = original;
    let sos = start + bytes[start..].windows(2).position(|p| p == [255, 218]).unwrap();
    let end = sos + 2 + u16::from_be_bytes([bytes[sos + 2], bytes[sos + 3]]) as usize;
    let count = u16::from_le_bytes([bytes[8], bytes[9]]) as usize;
    let entry = (0..count).map(|i| 10 + i * 12).find(|&i| u16::from_le_bytes([bytes[i], bytes[i + 1]]) == 325).unwrap();
    let at = u32::from_le_bytes(bytes[entry + 8..entry + 12].try_into().unwrap()) as usize;
    bytes[at..at + 4].copy_from_slice(&((end - start) as u32).to_le_bytes());
    let dng = LinearDng::open(bytes, DevelopOpts::default()).unwrap().unwrap();
    assert!(dng.tile(0).is_err(), "missing entropy");
}
