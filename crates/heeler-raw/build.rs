// Builds the vendored LibRaw (third_party/LibRaw-<LIBRAW_VERSION>) as a
// static library.
// 0.22.2 is required for Panasonic v7+ compression (pana8 decoder: S5 II,
// G9 II, ...); 0.21.x silently produced noise for those files.
// Source list mirrors LibRaw's Makefile.dist. zlib and jpeg ARE enabled
// (deflate and lossy DNG need them; see the blocks in main). The heavy
// integrations (RawSpeed, DNG SDK, X3F tools, LCMS) stay disabled: their
// files compile to guarded no-ops without the USE_* defines.

/// The vendored LibRaw release, named once.
///
/// It is a license fact as well as a build fact: LibRaw is used under
/// CDDL-1.0, which obliges us to make THIS source available to anyone
/// we hand a binary to, so anything that names a version has to name
/// the right one. It has been wrong before. The path was bumped to
/// 0.22.2 and the license note in Cargo.toml went on pointing at the
/// 0.21.3 tree that no longer exists, which is a broken citation on the
/// one file a lawyer would read first.
///
/// So it is exported to the crate as HEELER_RAW_LIBRAW_VERSION, the
/// user-facing license page has to quote it, and a test fails if the
/// page and the build disagree.
pub const LIBRAW_VERSION: &str = "0.22.2";

const SOURCES: &[&str] = &[
    "src/decoders/canon_600.cpp",
    "src/decoders/crx.cpp",
    "src/decoders/decoders_dcraw.cpp",
    "src/decoders/decoders_libraw_dcrdefs.cpp",
    "src/decoders/decoders_libraw.cpp",
    "src/decoders/dng.cpp",
    "src/decoders/fp_dng.cpp",
    "src/decoders/fuji_compressed.cpp",
    "src/decoders/generic.cpp",
    "src/decoders/kodak_decoders.cpp",
    "src/decoders/load_mfbacks.cpp",
    "src/decoders/olympus14.cpp",
    "src/decoders/pana8.cpp",
    "src/decoders/smal.cpp",
    "src/decoders/sonycc.cpp",
    "src/decoders/unpack_thumb.cpp",
    "src/decoders/unpack.cpp",
    "src/decompressors/losslessjpeg.cpp",
    "src/demosaic/aahd_demosaic.cpp",
    "src/demosaic/ahd_demosaic.cpp",
    "src/demosaic/dcb_demosaic.cpp",
    "src/demosaic/dht_demosaic.cpp",
    "src/demosaic/misc_demosaic.cpp",
    "src/demosaic/xtrans_demosaic.cpp",
    "src/integration/dngsdk_glue.cpp",
    "src/integration/rawspeed_glue.cpp",
    "src/libraw_c_api.cpp",
    "src/libraw_datastream.cpp",
    "src/metadata/adobepano.cpp",
    "src/metadata/canon.cpp",
    "src/metadata/ciff.cpp",
    "src/metadata/cr3_parser.cpp",
    "src/metadata/epson.cpp",
    "src/metadata/exif_gps.cpp",
    "src/metadata/fuji.cpp",
    "src/metadata/hasselblad_model.cpp",
    "src/metadata/identify_tools.cpp",
    "src/metadata/identify.cpp",
    "src/metadata/kodak.cpp",
    "src/metadata/leica.cpp",
    "src/metadata/makernotes.cpp",
    "src/metadata/mediumformat.cpp",
    "src/metadata/minolta.cpp",
    "src/metadata/misc_parsers.cpp",
    "src/metadata/nikon.cpp",
    "src/metadata/normalize_model.cpp",
    "src/metadata/olympus.cpp",
    "src/metadata/p1.cpp",
    "src/metadata/pentax.cpp",
    "src/metadata/samsung.cpp",
    "src/metadata/sony.cpp",
    "src/metadata/tiff.cpp",
    "src/postprocessing/aspect_ratio.cpp",
    "src/postprocessing/dcraw_process.cpp",
    "src/postprocessing/mem_image.cpp",
    "src/postprocessing/postprocessing_aux.cpp",
    "src/postprocessing/postprocessing_utils_dcrdefs.cpp",
    "src/postprocessing/postprocessing_utils.cpp",
    "src/preprocessing/ext_preprocess.cpp",
    "src/preprocessing/raw2image.cpp",
    "src/preprocessing/subtract_black.cpp",
    "src/tables/cameralist.cpp",
    "src/tables/colorconst.cpp",
    "src/tables/colordata.cpp",
    "src/tables/wblists.cpp",
    "src/utils/curves.cpp",
    "src/utils/decoder_info.cpp",
    "src/utils/init_close_utils.cpp",
    "src/utils/open.cpp",
    "src/utils/phaseone_processing.cpp",
    "src/utils/read_utils.cpp",
    "src/utils/thumb_utils.cpp",
    "src/utils/utils_dcraw.cpp",
    "src/utils/utils_libraw.cpp",
    "src/write/apply_profile.cpp",
    "src/write/file_write.cpp",
    "src/write/tiff_writer.cpp",
    "src/x3f/x3f_parse_process.cpp",
    "src/x3f/x3f_utils_patched.cpp",
];

fn main() {
    // No canonicalize(): on Windows it yields \\?\ paths that cl.exe rejects.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../third_party")
        .join(format!("LibRaw-{LIBRAW_VERSION}"));
    assert!(root.join("libraw").is_dir(), "vendored LibRaw missing at {}", root.display());

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .include(&root)
        .define("LIBRAW_NODLL", None)
        .warnings(false);

    // Deflate-compressed DNG, which is what a floating-point DNG used to
    // arrive as.
    //
    // Careful with the version of this comment that said "which is what
    // [a RAW editor]'s HDR Merge writes": measured 2026-08-25, that
    // editor currently writes its HDR merges as DNG 1.7, half-float, JPEG XL
    // (compression 52546) in tiles, and LibRaw decodes that only through
    // the DNG SDK, which is not built here. zlib still earns its
    // place for older float DNGs; it is just not the tag that opens an
    // HDR merge made today.
    //
    // USE_ZLIB gates deflate_dng_load_raw in src/decoders/fp_dng.cpp, and
    // without it a floating-point DNG simply fails to decode. The comment
    // at the top of this file lumps zlib in with RawSpeed and the DNG SDK
    // as an "optional integration", which is how it came to be off: those
    // two are heavy third-party projects worth avoiding, and zlib is
    // neither heavy nor GPL-family. It was never a licensing decision, it
    // was a decision made about four other things at once.
    //
    // libz-sys builds it from source rather than hunting for a system
    // copy, so Windows behaves like everything else.
    let zlib_include = std::env::var("DEP_Z_INCLUDE").ok();
    if let Some(inc) = &zlib_include {
        build.define("USE_ZLIB", None);
        for part in std::env::split_paths(inc) {
            build.include(part);
        }
    }

    // Lossy DNG, which is a RAW editor's Lossy export and what a good many
    // drones and phones write.
    //
    // USE_JPEG gates jpeg_src in src/libraw_datastream.cpp, which returns
    // -1 without it, and the lossy path has nothing to read through. Same
    // story as zlib: swept off with RawSpeed and the DNG SDK, and neither
    // heavy nor GPL-family.
    //
    // This block must sit BEFORE compile(): it once sat after, so the
    // define never reached the compiler and every platform shipped
    // without the lossy decoder while HEELER_RAW_JPEG said otherwise.
    // Defines are inert after compile() has already run the compiler.
    let target = std::env::var("TARGET").unwrap_or_default();
    let jpeg_include = std::env::var("DEP_JPEG_INCLUDE").ok();
    if let Some(inc) = &jpeg_include {
        build.define("USE_JPEG", None);
        for part in std::env::split_paths(inc) {
            build.include(part);
        }
        // Windows needs one more define, and it is this define or a
        // corrupted decoder.
        //
        // USE_JPEG is what finally lets internal/defines.h reach its
        // `#include <jpeglib.h>` (it guards the include with NO_JPEG,
        // which it defines itself whenever USE_JPEG is absent). That
        // include lands AFTER the winsock2.h a few lines above it, so on
        // Windows the Windows RPC headers get there first with
        // `typedef unsigned char boolean`, and then libjpeg's jmorecfg.h
        // says `typedef int boolean` and the compile dies. Nobody saw it
        // until USE_JPEG actually took effect.
        //
        // WIN32_LEAN_AND_MEAN keeps rpc.h out of windows.h, so libjpeg's
        // typedef is the only one in the translation unit. The obvious
        // alternative, HAVE_BOOLEAN, is a trap: it silences the error by
        // letting the Windows one-byte `boolean` win here, while the
        // mozjpeg library we link was compiled with the four-byte one.
        // Every boolean field in jpeg_decompress_struct would sit at a
        // different offset on each side of the call. It would build.
        if target.contains("windows") {
            build.define("WIN32_LEAN_AND_MEAN", None);
        }
    }

    if target.contains("msvc") {
        build.flag("/EHsc");
        // LibRaw sources contain non-UTF8 comments; silence codepage noise.
        build.flag("/wd4819");
    } else {
        build.flag_if_supported("-std=c++11");
        build.flag_if_supported("-fno-strict-aliasing");
    }
    for file in SOURCES {
        build.file(root.join(file));
    }
    build.file("src/shim.cpp");
    build.compile("raw");

    build_vc5(&target);

    if target.contains("windows") {
        println!("cargo:rustc-link-lib=ws2_32");
    }
    // Readable from the crate, so a test can assert the deflate DNG
    // decoder is actually compiled in rather than trusting that the
    // define took. A missing DEP_Z_INCLUDE fails silently otherwise: the
    // build succeeds, the guarded decoder is a no-op, and the only symptom
    // is a class of DNG that will not open.
    println!(
        "cargo:rustc-env=HEELER_RAW_JPEG={}",
        if jpeg_include.is_some() { "1" } else { "0" }
    );
    println!(
        "cargo:rustc-env=HEELER_RAW_ZLIB={}",
        if zlib_include.is_some() { "1" } else { "0" }
    );
    // A license fact as much as a build fact: the user-facing notice has
    // to name the tree we actually compiled, and a test holds it to this.
    println!("cargo:rustc-env=HEELER_RAW_LIBRAW_VERSION={LIBRAW_VERSION}");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src/shim.cpp");
    println!("cargo:rerun-if-changed=src/gpr_shim.c");
}

/// GoPro's VC-5 decoder (third_party/gpr-vc5, Apache-2.0 or MIT), the
/// part of the GPR SDK that unpacks a GPR's raw tile, built as its own
/// C library beside LibRaw. Only reading: the SDK's encoder, its patched
/// Adobe DNG SDK and XMP toolkit are not vendored; Heeler hands LibRaw
/// the decoded tile as an ordinary DNG (src/gpr.rs).
fn build_vc5(target: &str) {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../third_party/gpr-vc5");
    assert!(root.join("vc5_decoder").is_dir(), "vendored VC-5 decoder missing at {}", root.display());
    let mut build = cc::Build::new();
    build
        .include(root.join("vc5_decoder"))
        .include(root.join("vc5_common"))
        .include(root.join("common/private"))
        .include(root.join("common/public"))
        .define("GPR_READING", "1")
        .define("GPR_WRITING", "0")
        .define("GPR_TIMING", "0")
        // Upstream's checks are asserts; with them compiled out, the
        // hardened paths (third_party/gpr-vc5/README.md) return errors
        // where a debug build would abort on a damaged file.
        .define("NDEBUG", None)
        .warnings(false);
    if !target.contains("msvc") {
        build.flag_if_supported("-std=c99");
    }
    for dir in ["vc5_decoder", "vc5_common"] {
        let mut files: Vec<_> = std::fs::read_dir(root.join(dir))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "c"))
            .collect();
        files.sort();
        for f in files {
            build.file(f);
        }
    }
    for f in ["gpr_allocator.c", "gpr_buffer.c", "log.c", "timer.c"] {
        build.file(root.join("common/private").join(f));
    }
    build.file("src/gpr_shim.c");
    build.compile("gprvc5");
    println!("cargo:rerun-if-changed={}", root.display());
}
