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
    Opts { half_size: o.half_size, fixed_white: o.fixed_white, camera_wb: o.camera_wb, camera_matrix: o.camera_matrix, highlight: o.highlight, demosaic: o.demosaic, libraw_color: true }
}

/// Held while a test turns heeler-raw's process-wide routing to LibRaw
/// or to the Rust develop, so tests on other threads see the routing
/// they expect.
static ROUTING: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// LibRaw's develop, whatever the build's features.
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn libraw(bytes: &[u8], o: DevelopOpts) -> heeler_raw::SensorImage {
    let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    #[cfg(feature = "rust-decoder")]
    heeler_raw::rust_path::set_enabled(false);
    let s = heeler_raw::decode_sensor_with(bytes, o).expect("LibRaw develops the synthetic DNG");
    #[cfg(feature = "rust-decoder")]
    heeler_raw::rust_path::set_enabled(true);
    s
}

/// Every develop the app asks of a Bayer file, Rust against LibRaw.
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
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
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn lens_shading_opcodes_develop_as_heeler_raw_applies_them_around_libraw() {
    use heeler_rawdec::synthetic::{gain_map, opcode_list, vignette};
    // OpcodeList2: a smooth map on every site and a stronger one on one
    // color (pitch 2). OpcodeList3: a vignette, then a map on each color.
    let grid: Vec<f32> = (0..12).map(|i| 1.0 + 0.15 * (i % 4) as f32 + 0.1 * (i / 4) as f32).collect();
    let list2 = opcode_list(&[gain_map([0, 0, 52, 76], [0, 1], [1, 1], [3, 4], 1, &grid), gain_map([1, 0, 52, 76], [0, 1], [2, 2], [2, 2], 1, &[1.4, 1.0, 1.2, 1.6])]);
    let per_color: Vec<f32> = (0..2 * 2 * 3).map(|i| 1.0 + 0.05 * i as f32).collect();
    let list3 = opcode_list(&[vignette([0.3, 0.1, 0.0, 0.0, 0.0], 0.45, 0.55), gain_map([0, 0, 52, 76], [0, 3], [1, 1], [2, 2], 3, &per_color)]);
    for orientation in [1u16, 6] {
        let px = |y: usize, x: usize| scene(y, x) / 2;
        let bytes = cfa_dng(&Spec { width: 76, height: 52, tile: Some((32, 16)), orientation, opcodes2: Some(list2.clone()), opcodes3: Some(list3.clone()), pixel: &px, ..Spec::default() });
        same_as_libraw(&format!("lens shading, orientation {orientation}"), &bytes);
    }
    // An odd top and left edge, which the area moves in by one: the maps
    // and the black pattern as LibRaw's area takes them, the moved one (no
    // file in either corpus has an odd edge). The area moved is of even
    // size: at half size LibRaw reads OpcodeList2's maps over an odd
    // area less its last row and column, the Rust develop over the whole
    // area as at full size (no file with these maps has an odd area).
    let per_site = opcode_list(&[gain_map([0, 0, 50, 74], [0, 1], [2, 2], [2, 2], 1, &[1.4, 1.0, 1.2, 1.6]), gain_map([1, 1, 50, 74], [0, 1], [2, 2], [2, 2], 1, &[1.1, 1.3, 1.0, 1.2])]);
    let black = ((2, 2), vec![250 * 256, 262 * 256, 259 * 256, 255 * 256]);
    let px = |y: usize, x: usize| scene(y, x) / 2;
    let bytes = cfa_dng(&Spec { width: 76, height: 52, tile: Some((32, 16)), active: Some([1, 1, 52, 76]), black, opcodes2: Some(per_site), opcodes3: Some(list3.clone()), pixel: &px, ..Spec::default() });
    same_as_libraw("lens shading, odd area edges", &bytes);
    // An odd height: the half-size image the stage 3 maps are read over
    // counts the part block.
    let bytes = cfa_dng(&Spec { width: 71, height: 41, tile: None, opcodes3: Some(list3.clone()), pixel: &scene, ..Spec::default() });
    same_as_libraw("lens shading, odd sizes", &bytes);
}

/// A linear DNG's and a monochrome DNG's OpcodeList3 (a vignette, then a
/// map on each plane) as LibRaw's develop applies it with heeler-raw's
/// stage 3 pass: full size and half (both whole), Clip and Blend.
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn lens_shading_on_linear_and_monochrome_dngs_develops_as_libraw_does() {
    use heeler_rawdec::synthetic::{gain_map, opcode_list, vignette};
    for samples in [3u16, 1] {
        let per_plane: Vec<f32> = (0..2 * 2 * samples as usize).map(|i| 1.0 + 0.07 * i as f32).collect();
        let list3 = opcode_list(&[vignette([0.3, 0.1, 0.0, 0.0, 0.0], 0.45, 0.55), gain_map([0, 0, 41, 71], [0, samples as u32], [1, 1], [2, 2], samples as u32, &per_plane)]);
        for (what, opcodes3) in [("plain", None), ("lens shading", Some(list3))] {
            for orientation in [1u16, 6] {
                let px = move |y: usize, x: usize| scene(y, x / samples as usize) / 2 + (x % samples as usize) as u16 * 300;
                let bytes = cfa_dng(&Spec { width: 71, height: 41, tile: None, linear: samples, orientation, opcodes3: opcodes3.clone(), pixel: &px, ..Spec::default() });
                for half_size in [false, true] {
                    for highlight in [0, 2] {
                        let o = DevelopOpts { half_size, highlight, ..DevelopOpts::default() };
                        // A monochrome frame has no channels to blend, and
                        // LibRaw's Blend scales it by a headroom from
                        // multipliers it never applies: both are held to
                        // its Clip.
                        let theirs = libraw(&bytes, if samples == 1 { DevelopOpts { highlight: 0, ..o } } else { o });
                        let (mine, _) = heeler_rawdec::develop::develop(&bytes, &opts(o), None).unwrap_or_else(|e| panic!("{samples} samples, {what}: declined: {e}"));
                        let case = format!("{samples} samples, {what}, orientation {orientation}, half {half_size}, highlight {highlight}");
                        assert_eq!((mine.width, mine.height), (theirs.width, theirs.height), "{case}: size");
                        let first = mine.rgb.iter().zip(&theirs.rgb).position(|(a, b)| a != b);
                        assert!(first.is_none(), "{case}: differs first at sample {first:?} of {}", mine.rgb.len());
                    }
                }
            }
        }
    }
}

/// A CR2 made in code, its frame in slices: unpacked into the right
/// places, and developed as LibRaw does (given LibRaw's levels and
/// matrix), full size and half, Clip and Blend.
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn a_cr2_in_slices_develops_as_libraw_does() {
    let px = |y: usize, x: usize| 128 + (scene(y, x) >> 2).min(3900);
    let bytes = heeler_rawdec::synthetic::cr2("Canon EOS 20D", 3596, 2360, [1, 1728, 1868], [2000, 1024, 1024, 1500], &px);
    let plan = heeler_rawdec::Plan::new(&bytes, &opts(DevelopOpts::default())).unwrap();
    let mine = heeler_rawdec::develop::unpack(&bytes, &plan, None).unwrap();
    let expected: Vec<u16> = (plan.top..plan.top + plan.height).flat_map(|y| (plan.left..plan.left + plan.width).map(move |x| px(y, x))).collect();
    assert!(mine == expected, "the slices put back in place");
    let (w, h, theirs) = heeler_raw::libraw_mosaic(&bytes).unwrap();
    assert_eq!((plan.width, plan.height), (w, h));
    assert!(mine == theirs, "LibRaw's unpacked mosaic");
    let with = heeler_raw::with_libraw_numbers(&bytes, &plan).unwrap();
    for half_size in [false, true] {
        for highlight in [0, 2] {
            let o = DevelopOpts { half_size, highlight, ..DevelopOpts::default() };
            let theirs = libraw(&bytes, o);
            let (mine, _) = heeler_rawdec::develop::develop_with(&bytes, &with, &opts(o), None).unwrap();
            assert_eq!((mine.width, mine.height), (theirs.width, theirs.height));
            let first = mine.rgb.iter().zip(&theirs.rgb).position(|(a, b)| a != b);
            assert!(first.is_none(), "half {half_size}, highlight {highlight}: differs first at {first:?}");
        }
    }
    // The shipped develop: its own levels and the camera's calibrations
    // through the DNG model, at LibRaw's size, white kept white.
    let o = Opts { libraw_color: false, ..opts(DevelopOpts::default()) };
    let own = heeler_rawdec::Plan::new(&bytes, &o).unwrap();
    for row in own.rgb_cam {
        assert!((row.iter().sum::<f32>() - 1.0).abs() < 1e-5, "{:?}", own.rgb_cam);
    }
    let (img, _) = heeler_rawdec::develop(&bytes, &o, None).unwrap();
    let theirs = libraw(&bytes, DevelopOpts::default());
    assert_eq!((img.width, img.height), (theirs.width, theirs.height));
}

/// The slice tag as other bodies write it: no slices before the last (the
/// 6D Mark II's, the frame one slice wide), and no slices and no slice
/// width, the last narrower than the frame (the PowerShot G16's, the
/// frame unsliced). Both unpack as LibRaw does.
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn a_cr2_whose_slice_tag_states_one_slice_or_none_unpacks_as_libraw_does() {
    let px = |y: usize, x: usize| 128 + (scene(y, x) >> 2).min(3900);
    for slices in [[0, 3596, 3596], [0, 0, 3580]] {
        let bytes = heeler_rawdec::synthetic::cr2("Canon EOS 20D", 3596, 2360, slices, [2000, 1024, 1024, 1500], &px);
        let plan = heeler_rawdec::Plan::new(&bytes, &opts(DevelopOpts::default())).unwrap_or_else(|e| panic!("{slices:?}: {e}"));
        let mine = heeler_rawdec::develop::unpack(&bytes, &plan, None).unwrap();
        let expected: Vec<u16> = (plan.top..plan.top + plan.height).flat_map(|y| (plan.left..plan.left + plan.width).map(move |x| px(y, x))).collect();
        assert!(mine == expected, "{slices:?}: the frame in place");
        let (w, h, theirs) = heeler_raw::libraw_mosaic(&bytes).unwrap();
        assert_eq!((plan.width, plan.height), (w, h));
        assert!(mine == theirs, "{slices:?}: LibRaw's unpacked mosaic");
    }
}

/// As-shot white balance off develops in daylight, the balance the
/// camera's matrix implies, as LibRaw's develop without the camera's
/// balance did (the Source section's switch once refused every RAW).
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn without_the_cameras_balance_a_dng_develops_in_daylight_as_libraw_does() {
    let bytes = cfa_dng(&Spec { width: 76, pixel: &scene, ..Spec::default() });
    for half_size in [false, true] {
        let o = DevelopOpts { camera_wb: false, half_size, ..DevelopOpts::default() };
        let theirs = libraw(&bytes, o);
        let (mine, _) = heeler_rawdec::develop::develop(&bytes, &opts(o), None).unwrap();
        assert_eq!((mine.width, mine.height), (theirs.width, theirs.height));
        let first = mine.rgb.iter().zip(&theirs.rgb).position(|(a, b)| a != b);
        assert!(first.is_none(), "half {half_size}: differs first at {first:?}");
        let (shot, _) = heeler_rawdec::develop::develop(&bytes, &opts(DevelopOpts { half_size, ..DevelopOpts::default() }), None).unwrap();
        assert!(shot.rgb != mine.rgb, "half {half_size}: the same as the camera's balance");
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
        let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(feature = "rust-decoder")]
        heeler_raw::rust_path::set_enabled(false);
        let raw = heeler_raw::dimensions(&bytes).unwrap();
        let picture = heeler_raw::picture_dimensions(&bytes).unwrap();
        #[cfg(feature = "rust-decoder")]
        heeler_raw::rust_path::set_enabled(true);
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
    assert!(declined(&bytes, Opts { camera_matrix: false, ..base }), "no camera matrix");
    // Exactly two tiles across, each JPEG line a tile row: LibRaw reads
    // that layout two tile rows a line, and keeps such files.
    assert!(declined(&cfa_dng(&Spec { width: 64, height: 48, tile: Some((32, 16)), pixel: &scene, ..Spec::default() }), base), "a layout LibRaw reads its own way");
    // An X-Trans-like 2 by 2 with three greens is not Bayer.
    assert!(declined(&cfa_dng(&Spec { cfa: [1, 1, 1, 2], ..Spec { width: 76, pixel: &scene, ..Spec::default() } }), base));
    assert!(declined(b"II*\0\x08\0\0\0\0\0\0\0\0\0", base), "not a DNG");
    // A CR2 whose IFD0 orientation is 0 (some Canon firmware's): its way
    // up is only in model-by-model maker notes, which LibRaw reads.
    let px = |y: usize, x: usize| 128 + (scene(y, x) >> 2).min(3900);
    let sideways = heeler_rawdec::synthetic::cr2_oriented("Canon EOS 20D", 3596, 2360, [1, 1728, 1868], [2000, 1024, 1024, 1500], 0, &px);
    assert!(declined(&sideways, base), "an orientation tag outside 1 to 8");
}

/// With the rust-decoder feature, heeler-raw's own entry points take a
/// verified file to the Rust develop, with LibRaw's answers, and keep
/// every other file on LibRaw.
#[test]
#[cfg(all(feature = "rust-decoder", target_arch = "aarch64", target_vendor = "apple"))]
fn with_the_feature_heeler_raw_develops_verified_files_in_rust() {
    let bytes = cfa_dng(&Spec { width: 76, pixel: &scene, orientation: 6, ..Spec::default() });
    let theirs: Vec<_> = [false, true].iter().flat_map(|&half_size| [0, 2].map(move |highlight| DevelopOpts { half_size, highlight, ..DevelopOpts::default() })).map(|o| (o, libraw(&bytes, o))).collect();
    let lib_dims = (heeler_raw::dimensions(&bytes), heeler_raw::picture_dimensions(&bytes));
    let _routing = ROUTING.lock().unwrap_or_else(|e| e.into_inner());
    // The synthetic file's camera is on no list: LibRaw's.
    heeler_raw::rust_path::set_enabled(true);
    heeler_raw::rust_path::set_libraw_color(true);
    assert!(!heeler_raw::rust_path::takes(&bytes, DevelopOpts::default()), "an unverified camera stays on LibRaw");
    heeler_rawdec::set_verified_only(false);
    assert!(heeler_raw::rust_path::takes(&bytes, DevelopOpts::default()));
    for (o, lib) in &theirs {
        let rust = heeler_raw::decode_sensor_with(&bytes, *o).unwrap();
        assert_eq!((rust.width, rust.height), (lib.width, lib.height), "{o:?}");
        assert!(rust.rgb == lib.rgb && rust.sensor_data && rust.headroom == lib.headroom, "{o:?}");
    }
    assert_eq!((heeler_raw::dimensions(&bytes), heeler_raw::picture_dimensions(&bytes)).0.unwrap(), lib_dims.0.unwrap());
    assert_eq!(heeler_raw::picture_dimensions(&bytes).unwrap(), lib_dims.1.unwrap());
    let plan = heeler_rawdec::Plan::new(&bytes, &opts(DevelopOpts::default())).unwrap();
    assert_eq!(heeler_raw::develop_bytes(&bytes, DevelopOpts::default()).unwrap(), plan.bytes(false).unwrap());
    assert_eq!(heeler_raw::demosaic_extra_bytes(&bytes), plan.demosaic_extra());
    let stop = AtomicBool::new(true);
    assert!(matches!(heeler_raw::decode_sensor_until(&bytes, DevelopOpts::default(), &stop), Err(heeler_raw::RawError::Cancelled)));
    // A develop the Rust path does not do goes to LibRaw.
    assert!(!heeler_raw::rust_path::takes(&bytes, DevelopOpts { demosaic: 11, ..DevelopOpts::default() }));
    heeler_raw::rust_path::set_libraw_color(false);
    heeler_rawdec::set_verified_only(true);
}

/// The DNG color model, for a shot whose white is the daylight
/// calibration's own, is LibRaw's daylight matrix: the develop differs
/// from LibRaw's by rounding alone. Under tungsten it weights in the
/// tungsten calibration and so differs, keeping white white.
#[test]
#[cfg(all(target_arch = "aarch64", target_vendor = "apple"))]
fn the_dng_color_model_is_libraws_matrix_for_a_daylight_white() {
    let spec = |neutral| Spec { width: 76, pixel: &scene, neutral, ..Spec::default() };
    let matrices = Spec::default().matrices;
    let white = |m: &[f64; 9], xyz: [f64; 3]| [0, 1, 2].map(|i| m[3 * i] * xyz[0] + m[3 * i + 1] * xyz[1] + m[3 * i + 2] * xyz[2]);
    let norm = |v: [f64; 3]| v.map(|x| x / v[1]);
    let d65 = norm(white(&matrices[1], [0.95047, 1.0, 1.08883]));
    let bytes = cfa_dng(&spec(d65));
    let o = DevelopOpts { half_size: true, ..DevelopOpts::default() };
    let theirs = libraw(&bytes, o);
    let (mine, _) = heeler_rawdec::develop::develop(&bytes, &Opts { libraw_color: false, ..opts(o) }, None).unwrap();
    let worst = mine.rgb.iter().zip(&theirs.rgb).map(|(&a, &b)| (a as i32 - b as i32).abs()).max().unwrap();
    assert!(worst <= 2, "daylight: differs from LibRaw by up to {worst}");
    // Standard A's white: the model leans to ColorMatrix1.
    let a = norm(white(&matrices[0], [1.09850, 1.0, 0.35585]));
    let bytes = cfa_dng(&spec(a));
    let theirs = libraw(&bytes, o);
    let (mine, _) = heeler_rawdec::develop::develop(&bytes, &Opts { libraw_color: false, ..opts(o) }, None).unwrap();
    let worst = mine.rgb.iter().zip(&theirs.rgb).map(|(&a, &b)| (a as i32 - b as i32).abs()).max().unwrap();
    assert!(worst >= 8, "tungsten: the model should differ from the daylight matrix, by {worst}");
}
