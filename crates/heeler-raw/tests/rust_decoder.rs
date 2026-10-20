//! heeler-rawdec, the pure Rust develop, against LibRaw's develop of the
//! same file, on DNGs made here (no camera file needed): the unpacked
//! mosaic, and the developed output full size and half, Clip and Blend,
//! fixed white or not, to the bit. Lossless JPEG tiles and uncompressed
//! strips, every Bayer phase, the four common orientations, a black
//! pattern, a linearization table and margins. Then the contracts a
//! develop keeps for Heeler: cancellation, memory admission, sizes from
//! the header, and the files it leaves to LibRaw.
//!
//! The bit-exact develop is held on Apple's arm64 build, whose float
//! arithmetic (the multiply-adds clang fuses) heeler-rawdec reproduces;
//! the corpus test (rust_decoder_corpus.rs) holds it to the photographs.
use std::sync::atomic::AtomicBool;

use heeler_raw::DevelopOpts;
use heeler_rawdec::synthetic::{cfa_dng, scene, Spec};
use heeler_rawdec::Opts;

fn opts(o: DevelopOpts) -> Opts {
    Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic }
}

/// LibRaw's develop.
fn libraw(bytes: &[u8], o: DevelopOpts) -> heeler_raw::SensorImage {
    heeler_raw::decode_sensor_with(bytes, o).expect("LibRaw develops the synthetic DNG")
}

/// Every develop the app asks of a Bayer file, Rust against LibRaw.
fn same_as_libraw(what: &str, bytes: &[u8]) {
    let (w, h, theirs) = heeler_raw::libraw_mosaic(bytes).unwrap();
    let plan = heeler_rawdec::Plan::new(bytes, &opts(DevelopOpts::default())).unwrap_or_else(|e| panic!("{what}: declined: {e}"));
    let mine = heeler_rawdec::develop::unpack(bytes, &plan, None).unwrap();
    assert_eq!((plan.width, plan.height), (w, h), "{what}: active area");
    assert!(mine == theirs, "{what}: the unpacked mosaic differs");
    for half_size in [false, true] {
        for highlight in [0, 2] {
            for fixed_white in [false, true] {
                let o = DevelopOpts { half_size, highlight, fixed_white, ..DevelopOpts::default() };
                let theirs = libraw(bytes, o);
                let (mine, _) = heeler_rawdec::develop::develop(bytes, &opts(o), None).unwrap();
                let case = format!("{what}, half {half_size}, highlight {highlight}, fixed white {fixed_white}");
                assert_eq!((mine.width, mine.height), (theirs.width, theirs.height), "{case}: size");
                let first = mine.rgb.iter().zip(&theirs.rgb).position(|(a, b)| a != b);
                assert!(first.is_none(), "{case}: differs first at sample {first:?} of {}", mine.rgb.len());
                assert!((mine.headroom - theirs.headroom).abs() < 1e-6, "{case}: headroom {} vs {}", mine.headroom, theirs.headroom);
            }
        }
    }
}

#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn lossless_jpeg_tiles_develop_as_libraw_does_in_every_phase_and_orientation() {
    for cfa in [[0, 1, 1, 2], [2, 1, 1, 0], [1, 0, 2, 1], [1, 2, 0, 1]] {
        for orientation in [1u16, 3, 6, 8] {
            let bytes = cfa_dng(&Spec { width: 76, height: 52, tile: Some((32, 16)), cfa, orientation, pixel: &scene, ..Spec::default() });
            same_as_libraw(&format!("tiles, cfa {cfa:?}, orientation {orientation}"), &bytes);
        }
    }
}

#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn uncompressed_strips_develop_as_libraw_does() {
    for bits in [16u16, 12, 10, 14] {
        let max = (1u32 << bits) - 1;
        let px = move |y: usize, x: usize| ((scene(y, x) as u32 * max) / 16383) as u16;
        // Odd in both directions: half size leaves the last row and column.
        let bytes = cfa_dng(&Spec { width: 71, height: 41, tile: None, bits, white: max, black: ((1, 1), vec![(max / 64) * 256]), pixel: &px, ..Spec::default() });
        same_as_libraw(&format!("strips of {bits} bits"), &bytes);
    }
}

#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn a_black_pattern_a_linearization_table_and_margins_develop_as_libraw_does() {
    let bytes = cfa_dng(&Spec { width: 76, black: ((2, 2), vec![250 * 256, 262 * 256, 259 * 256 + 128, 255 * 256]), pixel: &scene, ..Spec::default() });
    same_as_libraw("a black pattern, one level a fraction", &bytes);
    let table: Vec<u16> = (0..4096u32).map(|i| ((i as f64 / 4095.0).powf(1.1) * 16383.0).round() as u16).collect();
    let px = |y: usize, x: usize| scene(y, x) >> 2;
    let bytes = cfa_dng(&Spec { width: 76, linearization: Some(table), pixel: &px, ..Spec::default() });
    same_as_libraw("a linearization table", &bytes);
    // Margins, even and odd (an odd edge moves in to keep the 2 by 2
    // whole), under a black pattern.
    for active in [[2, 4, 48, 70], [1, 1, 49, 69], [0, 1, 50, 71]] {
        let black = ((2, 2), vec![250 * 256, 262 * 256, 259 * 256, 255 * 256]);
        let bytes = cfa_dng(&Spec { width: 72, height: 50, tile: Some((32, 32)), active: Some(active), black, pixel: &scene, ..Spec::default() });
        same_as_libraw(&format!("margins {active:?}"), &bytes);
    }
}

#[test]
fn a_stopped_develop_ends_canceled() {
    let bytes = cfa_dng(&Spec { width: 76, pixel: &scene, ..Spec::default() });
    let stop = AtomicBool::new(true);
    let r = heeler_rawdec::develop::develop(&bytes, &opts(DevelopOpts::default()), Some(&stop));
    assert!(matches!(r, Err(heeler_rawdec::Error::Canceled)));
}

#[test]
fn a_develop_is_admitted_whole_and_refused_short_of_it() {
    let bytes = cfa_dng(&Spec { width: 256, height: 128, tile: Some((64, 64)), pixel: &scene, ..Spec::default() });
    for half in [false, true] {
        let o = Opts { half_size: half, ..opts(DevelopOpts::default()) };
        let plan = heeler_rawdec::Plan::new(&bytes, &o).unwrap();
        let need = plan.bytes(half).unwrap();
        let ok = heeler_engine::memory::with_budget(need, || heeler_rawdec::develop::develop(&bytes, &o, None).map(|_| ()));
        assert!(ok.is_ok(), "half {half}: within its own estimate: {ok:?}");
        let short = heeler_engine::memory::with_budget(need - 1, || heeler_rawdec::develop::develop(&bytes, &o, None).map(|_| ()));
        assert!(matches!(short, Err(heeler_rawdec::Error::Memory(_))), "half {half}: one byte short");
    }
}

#[test]
fn sizes_from_the_header_are_libraws() {
    for orientation in [1u16, 6] {
        let bytes = cfa_dng(&Spec { width: 72, height: 50, tile: Some((32, 32)), active: Some([2, 4, 48, 70]), orientation, pixel: &scene, ..Spec::default() });
        let plan = heeler_rawdec::Plan::new(&bytes, &opts(DevelopOpts::default())).unwrap();
            let raw = heeler_raw::dimensions(&bytes).unwrap();
        let picture = heeler_raw::picture_dimensions(&bytes).unwrap();
        assert_eq!((plan.dng.width, plan.dng.height), raw, "orientation {orientation}");
        assert_eq!(plan.output_size(false), picture, "orientation {orientation}");
    }
}

#[test]
fn files_outside_the_verified_develop_are_left_to_libraw() {
    let plain = Spec { width: 76, pixel: &scene, ..Spec::default() };
    let base = opts(DevelopOpts::default());
    let declined = |bytes: &[u8], o: Opts| matches!(heeler_rawdec::Plan::new(bytes, &o), Err(heeler_rawdec::Error::Unsupported(_)));
    let bytes = cfa_dng(&plain);
    assert!(!declined(&bytes, base));
    assert!(declined(&bytes, Opts { demosaic: 0, ..base }), "another demosaic");
    assert!(declined(&bytes, Opts { highlight: 5, ..base }), "a highlight rebuild");
    assert!(declined(&bytes, Opts { camera_wb: false, ..base }), "no camera white balance");
    // OpcodeList3 with a FixVignetteRadial, which heeler-raw applies
    // around LibRaw's develop.
    let mut list = 1u32.to_be_bytes().to_vec();
    for v in [3u32, 0x01030000, 0, 56] {
        list.extend_from_slice(&v.to_be_bytes());
    }
    list.extend(std::iter::repeat_n(0, 56));
    assert!(declined(&cfa_dng(&Spec { opcodes3: Some(list), ..plain }), base), "lens shading opcodes");
    // Exactly two tiles across, each JPEG line a tile row: LibRaw reads
    // that layout two tile rows a line, and keeps such files.
    assert!(declined(&cfa_dng(&Spec { width: 64, height: 48, tile: Some((32, 16)), pixel: &scene, ..Spec::default() }), base), "a layout LibRaw reads its own way");
    // An X-Trans-like 2 by 2 with three greens is not Bayer.
    assert!(declined(&cfa_dng(&Spec { cfa: [1, 1, 1, 2], ..Spec { width: 76, pixel: &scene, ..Spec::default() } }), base));
    assert!(declined(b"II*\0\x08\0\0\0\0\0\0\0\0\0", base), "not a DNG");
}

