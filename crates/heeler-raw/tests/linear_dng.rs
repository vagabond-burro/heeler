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
