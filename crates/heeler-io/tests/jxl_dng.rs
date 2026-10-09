//! JPEG XL DNG against real files. The format cannot be synthesized
//! here (nothing in the tree writes JPEG XL), so the checks that need a
//! file are opt-in and skip cleanly when it is absent:
//!
//!   HEELER_JXL_DNG=F:\...\lossy.dng \
//!   HEELER_JXL_DNG_REF=F:\...\lossy-cr71.dng \
//!   cargo test -p heeler-io --features libraw --test jxl_dng -- --ignored --nocapture
//!
//! `HEELER_JXL_DNG_REF` is the interesting one: point it at the SAME
//! photograph exported to a compression LibRaw can read (a DNG
//! converter's `-lossy -cr7.1` writes the old 34892 flavor), and the two
//! decoders' renderings are compared. That comparison is what caught the
//! difference between a working color pipeline and a plausible-looking
//! one: rawler renders these files with a mean of 0.90 where LibRaw says
//! 0.13, and nothing but a reference file makes that visible.

use std::path::PathBuf;

use heeler_engine::ImageBuf;

fn mean_of(img: &ImageBuf) -> f64 {
    let mut sum = 0.0;
    let mut n = 0u64;
    for px in img.data.chunks_exact(4) {
        for v in &px[..3] {
            sum += *v as f64;
            n += 1;
        }
    }
    sum / n.max(1) as f64
}

#[test]
fn develop_sanity_is_available_without_an_optional_raw_decoder() {
    let flat = ImageBuf::filled(16, 16, [0.25, 0.25, 0.25, 1.0]);
    assert!(heeler_io::develop_looks_sane(&flat));
    let mut stripes = flat;
    for y in 0..16 {
        for x in 0..16 {
            stripes.set_pixel(x, y, [0.0, (x % 2) as f32, 0.0, 1.0]);
        }
    }
    assert!(!heeler_io::develop_looks_sane(&stripes));
}

#[test]
#[ignore]
fn a_real_jpeg_xl_dng_decodes_to_a_photograph() {
    let Some(path) = std::env::var_os("HEELER_JXL_DNG").map(PathBuf::from) else {
        eprintln!("HEELER_JXL_DNG not set; skipping");
        return;
    };
    let bytes = std::fs::read(&path).unwrap();

    assert!(
        heeler_io::is_jxl_dng(&bytes),
        "{} is not a JPEG XL DNG, so this test is pointed at the wrong file",
        path.display()
    );

    let img = heeler_io::decode_jxl_dng(&bytes).expect("the JPEG XL DNG should decode");
    println!("decoded {} x {}, mean {:.4}", img.width, img.height, mean_of(&img));

    // Full size, not the embedded preview. The preview in these files can
    // be 256 pixels wide, which is the failure this whole path exists to
    // stop being invisible.
    let exif = heeler_io::read_exif(&bytes);
    if let (Some(w), Some(h)) = (exif.width, exif.height) {
        let (w, h) = (w as usize, h as usize);
        assert!(
            (img.width == w && img.height == h) || (img.width == h && img.height == w),
            "decoded {}x{} but the file declares {w}x{h}",
            img.width,
            img.height
        );
    }

    // Real pixels: finite, non-negative, and not a uniform field.
    let mut min = f32::MAX;
    let mut max = f32::MIN;
    for px in img.data.chunks_exact(4) {
        for v in &px[..3] {
            assert!(v.is_finite(), "a non-finite sample reached the buffer");
            assert!(*v >= 0.0, "a negative sample reached the buffer: {v}");
            min = min.min(*v);
            max = max.max(*v);
        }
    }
    assert!(max > min, "the decode produced a flat image");
    assert!(max > 0.01, "the decode produced an essentially black image");

    // The develop must be one the ordinary path would accept, or the app
    // would throw it away and show the preview anyway.
    assert!(
        heeler_io::develop_looks_sane(&img),
        "the decode reads as noise, which would trigger the preview fallback"
    );

    // And the app's own entry point must return this, not a fallback.
    let through = heeler_io::decode_any(&path).expect("decode_any should serve the JXL develop");
    assert_eq!(
        (through.width, through.height),
        (img.width, img.height),
        "decode_any did not use the JPEG XL decoder"
    );
}

/// The same photograph through both decoders must render the same.
///
/// This is the check with teeth. A color pipeline can be wrong in ways
/// that still produce a pretty picture: a missing MapPolynomial opcode,
/// the ForwardMatrix used without white balance, levels normalized
/// against the wrong maximum. All of those survive an eyeball test and
/// none of them survive this one.
#[test]
#[ignore]
fn the_jpeg_xl_render_matches_libraw_on_the_same_photograph() {
    let (Some(jxl), Some(reference)) = (
        std::env::var_os("HEELER_JXL_DNG").map(PathBuf::from),
        std::env::var_os("HEELER_JXL_DNG_REF").map(PathBuf::from),
    ) else {
        eprintln!("HEELER_JXL_DNG / HEELER_JXL_DNG_REF not both set; skipping");
        return;
    };

    let ours = heeler_io::decode_jxl_dng(&std::fs::read(&jxl).unwrap()).expect("JXL decode");
    let theirs = heeler_io::decode_any(&reference).expect("reference decode");

    assert_eq!(
        (ours.width, ours.height),
        (theirs.width, theirs.height),
        "the two files are not the same photograph at the same size"
    );

    // Per channel too, because a mean can match while the color does
    // not. This is the check that would catch the illuminant
    // simplification (the D65 ForwardMatrix used unconditionally) if it
    // mattered on this frame.
    let chan = |img: &ImageBuf, c: usize| -> f64 {
        let mut sum = 0.0;
        let mut n = 0u64;
        for px in img.data.chunks_exact(4) {
            sum += px[c] as f64;
            n += 1;
        }
        sum / n.max(1) as f64
    };
    for c in 0..3 {
        let (x, y) = (chan(&ours, c), chan(&theirs, c));
        println!("  channel {c}: ours {x:.4}, libraw {y:.4}, ratio {:.4}", x / y);
    }

    let (a, b) = (mean_of(&ours), mean_of(&theirs));
    println!("jpeg xl mean {a:.4}, reference mean {b:.4}, ratio {:.4}", a / b);

    // 3% covers the difference between two lossy compressions of one
    // frame. It does not cover a pipeline mistake, which shows up as tens
    // of percent or as a multiple.
    let ratio = a / b;
    assert!(
        (0.97..=1.03).contains(&ratio),
        "the JPEG XL render is {ratio:.3}x the LibRaw render of the same photograph; \
         that is a color-pipeline difference, not compression loss"
    );
}
