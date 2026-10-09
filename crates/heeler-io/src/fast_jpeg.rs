//! The viewer's JPEG: the same baseline 4:4:4 JPEG at the same quality
//! as encode_jpeg, written by libjpeg-turbo's SIMD encoder (mozjpeg with
//! its extensions off) instead of the image crate's scalar one.
//!
//! 2026-09-30: "do the faster JPEG compressor for drag frames". During a
//! slider drag the gesture-tier frame (1024 px) cost about 11 ms to
//! encode against 1.6 ms to render on the GPU; the 2048 px rest frame
//! about 48 ms. Measured on the M-series Mac over a real RAW (the slider
//! probe and the webview harness in the commit message): the SIMD encoder
//! is 2.3 ms against 6.0 ms for the same frame's compression, with the
//! same error against the source (mean 1.71 levels, max 24 against 25).
//!
//! mozjpeg is already linked for LibRaw's lossy DNG decode (heeler-raw),
//! so this is no new code in the binary and no new license: the notice
//! and the IJG sentence it requires ship already. `JCP_FASTEST` turns
//! mozjpeg's trellis quantization, progressive scans and table
//! optimization off, which is what makes it libjpeg-turbo's speed; those
//! extensions buy smaller files at several times the time, the wrong
//! trade for a frame that lives one IPC hop.
//!
//! Where SIMD comes from, per shipping target: NEON intrinsics and the
//! GNU assembler on macOS arm64 (always); NASM on Windows and Linux x64
//! (linux-setup.sh installs it; on Windows the build scripts warn when
//! it is missing). Without NASM mozjpeg builds its scalar C path, which
//! measured at the jpeg-encoder crate's speed on this Mac, still ahead of
//! the image crate: slower than it could be, never broken.

use crate::{icc, srgb_u8, IoError};
use heeler_engine::memory::{self, Job, MemoryError};
use heeler_engine::ImageBuf;
use mozjpeg_sys::*;
use rayon::prelude::*;
use std::os::raw::c_int;

/// What a libjpeg error unwinds with, so the catch below can tell the
/// library's refusal from any other panic.
struct LibjpegError(String);

unsafe extern "C-unwind" fn error_exit(cinfo: &mut jpeg_common_struct) {
    // The code, not the formatted text: format_message writes through a
    // pointer the binding types as shared, and a code is what a bug
    // report needs anyway (jerror.h lists them).
    let code = (*cinfo.err).msg_code;
    std::panic::resume_unwind(Box::new(LibjpegError(format!("libjpeg error {code}"))));
}

/// Warnings (a corrupt input is the decoder's business; the encoder has
/// none worth a line) are dropped rather than printed to stderr.
unsafe extern "C-unwind" fn emit_message(_: &mut jpeg_common_struct, _: c_int) {}

/// A destination manager that writes into a Rust Vec: libjpeg's own
/// memory destination mallocs, and a buffer from one C runtime freed by
/// another is exactly the Windows bug nobody can reproduce on a Mac.
#[repr(C)]
struct VecDest {
    mgr: jpeg_destination_mgr,
    chunk: Vec<u8>,
    out: Vec<u8>,
}

const CHUNK: usize = 64 * 1024;

unsafe fn dest(cinfo: &mut jpeg_compress_struct) -> &mut VecDest {
    // mgr is the first field of a repr(C) struct: the pointers agree.
    &mut *(cinfo.dest as *mut VecDest)
}

fn keep(d: &mut VecDest, n: usize) {
    if d.out.try_reserve(n).is_err() {
        std::panic::resume_unwind(Box::new(LibjpegError("not enough memory for the encoded image".into())));
    }
    d.out.extend_from_slice(&d.chunk[..n]);
}

unsafe extern "C-unwind" fn init_destination(cinfo: &mut jpeg_compress_struct) {
    let d = dest(cinfo);
    d.mgr.next_output_byte = d.chunk.as_mut_ptr();
    d.mgr.free_in_buffer = d.chunk.len();
}

unsafe extern "C-unwind" fn empty_output_buffer(cinfo: &mut jpeg_compress_struct) -> boolean {
    let d = dest(cinfo);
    // Called with the whole chunk full, whatever free_in_buffer says.
    keep(d, CHUNK);
    d.mgr.next_output_byte = d.chunk.as_mut_ptr();
    d.mgr.free_in_buffer = d.chunk.len();
    1
}

unsafe extern "C-unwind" fn term_destination(cinfo: &mut jpeg_compress_struct) {
    let d = dest(cinfo);
    let used = CHUNK - d.mgr.free_in_buffer;
    keep(d, used);
}

/// Owns the compressor so a libjpeg error unwinding out of any call
/// still frees what the library allocated.
struct Compressor {
    cinfo: jpeg_compress_struct,
}
impl Drop for Compressor {
    fn drop(&mut self) {
        unsafe { jpeg_destroy_compress(&mut self.cinfo) };
    }
}

/// The ICC APP2 segment as the specification lays it out: the signature,
/// this chunk's number and the chunk count, then the profile. The sRGB
/// profile is a few hundred bytes, one chunk.
fn icc_segment(profile: &[u8]) -> Vec<u8> {
    let mut seg = Vec::with_capacity(14 + profile.len());
    seg.extend_from_slice(b"ICC_PROFILE\0");
    seg.extend_from_slice(&[1, 1]);
    seg.extend_from_slice(profile);
    seg
}

/// The linear buffer as 8-bit sRGB RGB rows, one rayon task per band of
/// rows: the table lookup is per sample and the rows are independent.
fn srgb_rows(buf: &ImageBuf) -> Result<Vec<u8>, IoError> {
    let count = memory::bytes(buf.width, buf.height, 1, 3)?;
    let mut out = memory::vector(count, 0u8, "encoder pixels")?;
    let (w, h) = (buf.width, buf.height);
    if w == 0 || h == 0 {
        return Ok(out);
    }
    out.par_chunks_mut(w * 3)
        .zip(buf.data.par_chunks(w * 4))
        .for_each(|(row, src)| {
            for (o, s) in row.chunks_exact_mut(3).zip(src.chunks_exact(4)) {
                o[0] = srgb_u8(s[0]);
                o[1] = srgb_u8(s[1]);
                o[2] = srgb_u8(s[2]);
            }
        });
    Ok(out)
}

/// encode_jpeg's contract (8-bit sRGB, no alpha, baseline, 4:4:4, the
/// sRGB profile embedded, quality 1 to 100) through libjpeg-turbo's SIMD
/// encoder. For the viewer's frames; exports keep encode_jpeg.
pub fn encode_jpeg_fast(buf: &ImageBuf, quality: u8) -> Result<Vec<u8>, IoError> {
    let _job = Job::admit(memory::sum([memory::bytes(buf.width, buf.height, 1, 48)?, 64 * 1024])?, "image encoding, metadata and output")?;
    if buf.width == 0 || buf.height == 0 || buf.width > 65_500 || buf.height > 65_500 {
        return Err(MemoryError::Geometry("JPEG dimensions".into()).into());
    }
    if buf.data.len() < buf.width * buf.height * 4 {
        return Err(MemoryError::Geometry("encoder pixels".into()).into());
    }
    let rgb = srgb_rows(buf)?;
    compress(&rgb, buf.width, buf.height, quality)
}

/// Packed 8-bit RGB rows to a JPEG. A libjpeg error (it raises them
/// through error_exit, which would otherwise exit the process) unwinds
/// to the catch here and comes back as an IoError.
fn compress(rgb: &[u8], w: usize, h: usize, quality: u8) -> Result<Vec<u8>, IoError> {
    assert!(rgb.len() >= w * h * 3, "fewer rows than the frame");
    let icc = icc_segment(icc::srgb_profile());
    let quality = quality.clamp(1, 100) as c_int;

    let mut err: jpeg_error_mgr = unsafe { std::mem::zeroed() };
    let mut sink = Box::new(VecDest {
        mgr: jpeg_destination_mgr {
            next_output_byte: std::ptr::null_mut(),
            free_in_buffer: 0,
            init_destination: Some(init_destination),
            empty_output_buffer: Some(empty_output_buffer),
            term_destination: Some(term_destination),
        },
        chunk: vec![0u8; CHUNK],
        out: Vec::new(),
    });
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        let mut c = Compressor { cinfo: std::mem::zeroed() };
        c.cinfo.common.err = jpeg_std_error(&mut err);
        err.error_exit = Some(error_exit);
        err.emit_message = Some(emit_message);
        jpeg_create_compress(&mut c.cinfo);
        c.cinfo.dest = &mut sink.mgr;
        c.cinfo.image_width = w as JDIMENSION;
        c.cinfo.image_height = h as JDIMENSION;
        c.cinfo.input_components = 3;
        c.cinfo.in_color_space = J_COLOR_SPACE::JCS_RGB;
        // Before set_defaults, which reads the profile: plain
        // libjpeg-turbo behavior, baseline Huffman, no trellis.
        jpeg_c_set_int_param(&mut c.cinfo, J_INT_PARAM::JINT_COMPRESS_PROFILE, JINT_COMPRESS_PROFILE_VALUE::JCP_FASTEST as c_int);
        jpeg_set_defaults(&mut c.cinfo);
        jpeg_set_quality(&mut c.cinfo, quality, 1);
        // 4:4:4, as the image crate writes: the owner judges color
        // edges, and 4:2:0 halves the chroma along every one of them.
        let comps = std::slice::from_raw_parts_mut(c.cinfo.comp_info, c.cinfo.num_components as usize);
        for comp in comps.iter_mut() {
            comp.h_samp_factor = 1;
            comp.v_samp_factor = 1;
        }
        c.cinfo.dct_method = J_DCT_METHOD::JDCT_ISLOW;
        jpeg_start_compress(&mut c.cinfo, 1);
        jpeg_write_marker(&mut c.cinfo, 0xE2, icc.as_ptr(), icc.len() as u32);
        let rows: Vec<*const u8> = (0..h).map(|y| rgb.as_ptr().add(y * w * 3)).collect();
        while (c.cinfo.next_scanline as usize) < h {
            let at = c.cinfo.next_scanline as usize;
            let wrote = jpeg_write_scanlines(&mut c.cinfo, rows[at..].as_ptr() as JSAMPARRAY, (h - at) as JDIMENSION);
            if wrote == 0 {
                std::panic::resume_unwind(Box::new(LibjpegError("the encoder took no rows".into())));
            }
        }
        jpeg_finish_compress(&mut c.cinfo);
    }));
    match result {
        Ok(()) => Ok(std::mem::take(&mut sink.out)),
        Err(payload) => match payload.downcast::<LibjpegError>() {
            Ok(e) => Err(IoError::Image(image::ImageError::Encoding(image::error::EncodingError::new(
                image::error::ImageFormatHint::Exact(image::ImageFormat::Jpeg),
                e.0,
            )))),
            Err(other) => std::panic::resume_unwind(other),
        },
    }
}

/// Owns the decompressor for the same reason Compressor exists.
struct Decompressor {
    cinfo: jpeg_decompress_struct,
}
impl Drop for Decompressor {
    fn drop(&mut self) {
        unsafe { jpeg_destroy_decompress(&mut self.cinfo) };
    }
}

/// The DCT scale denominator for a reduced decode: the largest of 8, 4
/// and 2 whose output still reaches `edge` on the long side, or 1 when
/// none does.
fn reduction(long: usize, edge: usize) -> u32 {
    [8u32, 4, 2].into_iter().find(|d| long.div_ceil(*d as usize) >= edge).unwrap_or(1)
}

/// A JPEG decoded as packed 8-bit RGB rows. An edge of zero keeps every pixel.
///
/// libjpeg can skip most of the inverse DCT when it is asked for a half,
/// quarter or eighth of the frame, so the full frame is never built.
/// That matters for a stack's preview: the owner's bird trails are
/// frames from 8K video, 7680 by 4320, and a 2048 preview needs a
/// quarter of that. The full decode built 33 megapixels of float per
/// frame to throw 15 of every 16 away. None for a JPEG this path does
/// not handle (CMYK, or nothing to gain from reducing it); the caller
/// then decodes the usual way.
pub(crate) fn decode_reduced(bytes: &[u8], edge: usize) -> Result<Option<(usize, usize, Vec<u8>)>, IoError> {
    let mut err: jpeg_error_mgr = unsafe { std::mem::zeroed() };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
        let mut d = Decompressor { cinfo: std::mem::zeroed() };
        d.cinfo.common.err = jpeg_std_error(&mut err);
        err.error_exit = Some(error_exit);
        err.emit_message = Some(emit_message);
        jpeg_create_decompress(&mut d.cinfo);
        jpeg_mem_src(&mut d.cinfo, bytes.as_ptr(), bytes.len() as _);
        jpeg_read_header(&mut d.cinfo, 1);
        if !matches!(d.cinfo.jpeg_color_space, J_COLOR_SPACE::JCS_YCbCr | J_COLOR_SPACE::JCS_RGB | J_COLOR_SPACE::JCS_GRAYSCALE) {
            return Ok(None);
        }
        let long = (d.cinfo.image_width as usize).max(d.cinfo.image_height as usize);
        let denom = if edge == 0 { 1 } else { reduction(long, edge) };
        if denom == 1 && edge != 0 {
            return Ok(None);
        }
        d.cinfo.scale_num = 1;
        d.cinfo.scale_denom = denom;
        d.cinfo.out_color_space = J_COLOR_SPACE::JCS_RGB;
        d.cinfo.dct_method = J_DCT_METHOD::JDCT_ISLOW;
        jpeg_calc_output_dimensions(&mut d.cinfo);
        let (w, h) = (d.cinfo.output_width as usize, d.cinfo.output_height as usize);
        let count = memory::bytes(w, h, 1, 3)?;
        // Progressive input keeps full-size coefficient arrays even when
        // the output is reduced. Admit those before libjpeg starts work.
        let native = memory::bytes(d.cinfo.image_width as usize, d.cinfo.image_height as usize, 1, 16)?;
        let _job = Job::admit(memory::sum([native, count, bytes.len()])?, "JPEG decoder workspace")?;
        jpeg_start_decompress(&mut d.cinfo);
        let mut rgb = memory::vector(count, 0u8, "reduced JPEG samples")?;
        while (d.cinfo.output_scanline as usize) < h {
            let at = d.cinfo.output_scanline as usize;
            let mut row = rgb.as_mut_ptr().add(at * w * 3);
            if jpeg_read_scanlines(&mut d.cinfo, &mut row, 1) == 0 {
                std::panic::resume_unwind(Box::new(LibjpegError("the decoder gave no rows".into())));
            }
        }
        jpeg_finish_decompress(&mut d.cinfo);
        Ok(Some((w, h, rgb)))
    }));
    match result {
        Ok(r) => r,
        Err(payload) => match payload.downcast::<LibjpegError>() {
            Ok(e) => Err(IoError::Image(image::ImageError::Decoding(image::error::DecodingError::new(
                image::error::ImageFormatHint::Exact(image::ImageFormat::Jpeg),
                e.0,
            )))),
            Err(other) => std::panic::resume_unwind(other),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_progressive_jpeg_admits_native_workspace_before_starting() {
        let bytes = include_bytes!("../tests/fixtures/stack-progressive.jpg");
        let result = memory::with_budget(32 << 10, || decode_reduced(bytes, 64));
        assert!(result.is_err(), "a small RGB output does not bound progressive coefficient storage");
        assert!(memory::is_refusal(&result.unwrap_err().to_string()));
    }

    #[test]
    fn progressive_and_gray_jpegs_decode_and_cmyk_uses_the_portable_decoder() {
        for bytes in [include_bytes!("../tests/fixtures/stack-progressive.jpg").as_slice(), include_bytes!("../tests/fixtures/stack-gray.jpg").as_slice()] {
            let (w, h, rgb) = decode_reduced(bytes, 64).unwrap().unwrap();
            assert_eq!((w, h, rgb.len()), (64, 32, 64 * 32 * 3));
            assert_eq!(crate::decode_bytes(bytes).unwrap().width, 256);
        }
        let cmyk = include_bytes!("../tests/fixtures/stack-cmyk.jpg");
        assert!(decode_reduced(cmyk, 64).unwrap().is_none());
        assert_eq!(crate::decode_bytes(cmyk).unwrap().width, 256);
    }

    #[test]
    fn unsupported_precision_and_truncated_jpegs_return_errors() {
        let bytes = include_bytes!("../tests/fixtures/stack-gray.jpg");
        let mut twelve = bytes.to_vec();
        let sof = twelve.windows(2).position(|v| v == [255, 192]).unwrap();
        twelve[sof + 4] = 12;
        assert!(decode_reduced(&twelve, 64).is_err());
        assert!(crate::decode_bytes(&twelve).is_err());
        assert!(decode_reduced(&bytes[..32], 64).is_err());
        assert!(decode_reduced(bytes, 64).unwrap().is_some());
    }

    /// The reduction never goes below what was asked for, and an image
    /// already near the edge decodes whole.
    #[test]
    fn the_reduced_decode_still_reaches_the_edge() {
        assert_eq!(reduction(7680, 2048), 2, "a quarter would be 1920, short of 2048");
        assert_eq!(reduction(7680, 1920), 4);
        assert_eq!(reduction(7680, 960), 8);
        assert_eq!(reduction(2048, 2048), 1);
        assert_eq!(reduction(3000, 2048), 1);
    }

    /// A reduced decode is the same picture at a smaller size: a frame
    /// encoded here and decoded at a quarter matches the frame shrunk
    /// by four, within JPEG's own error.
    #[test]
    fn a_reduced_decode_is_the_same_picture_smaller() {
        let src = frame(256, 128);
        let jpeg = encode_jpeg_fast(&src, 95).unwrap();
        let (w, h, rgb) = decode_reduced(&jpeg, 64).unwrap().expect("a quarter reaches 64");
        assert_eq!((w, h), (64, 32));
        // Away from the checker edges, where any downscale blurs.
        let (x, y) = (40usize, 26usize);
        let sx = x * 4 + 1;
        let sy = y * 4 + 1;
        let want = src.pixel(sx, sy);
        for c in 0..3 {
            let got = rgb[(y * w + x) * 3 + c];
            let expect = crate::srgb_u8(want[c]);
            assert!((got as i32 - expect as i32).abs() <= 12, "channel {c}: {got} against {expect}");
        }
        assert!(decode_reduced(&jpeg, 256).unwrap().is_none(), "nothing to gain at full size");
        assert!(decode_reduced(b"not a jpeg", 64).is_err());
    }

    /// A frame with hard color edges and smooth ramps, the two things a
    /// JPEG gets wrong in different ways.
    fn frame(w: usize, h: usize) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 4;
                let (r, g, b) = if (x / 16 + y / 16) % 2 == 0 {
                    (0.8, 0.05, 0.02)
                } else {
                    (x as f32 / w as f32, y as f32 / h as f32, 0.6)
                };
                img.data[i] = r;
                img.data[i + 1] = g;
                img.data[i + 2] = b;
                img.data[i + 3] = 1.0;
            }
        }
        img
    }

    fn rgb8(bytes: &[u8]) -> image::RgbImage {
        image::load_from_memory(bytes).unwrap().to_rgb8()
    }

    #[test]
    fn the_fast_frame_decodes_to_the_same_size_and_pixels_as_the_old_encoder() {
        let img = frame(683, 1024);
        let fast = encode_jpeg_fast(&img, 94).unwrap();
        let old = crate::encode_jpeg(&img, 94).unwrap();
        assert_eq!(&fast[..2], &[0xFF, 0xD8]);
        let (a, b) = (rgb8(&fast), rgb8(&old));
        assert_eq!(a.dimensions(), (683, 1024));
        assert_eq!(a.dimensions(), b.dimensions());
        // Two encoders of the same quality and sampling differ by DCT
        // rounding, not by what the picture shows.
        let (mut sum, mut max) = (0u64, 0u8);
        for (p, q) in a.as_raw().iter().zip(b.as_raw()) {
            let d = p.abs_diff(*q);
            sum += d as u64;
            max = max.max(d);
        }
        let mean = sum as f64 / a.as_raw().len() as f64;
        assert!(mean < 1.0, "mean difference {mean} levels against the old encoder");
        assert!(max <= 24, "max difference {max} levels against the old encoder");
    }

    #[test]
    fn the_fast_frame_is_as_close_to_the_source_as_the_old_one() {
        let img = frame(512, 384);
        let src: Vec<u8> = img.data.chunks_exact(4).flat_map(|p| [srgb_u8(p[0]), srgb_u8(p[1]), srgb_u8(p[2])]).collect();
        let err = |bytes: &[u8]| {
            let d = rgb8(bytes);
            d.as_raw().iter().zip(&src).map(|(a, b)| a.abs_diff(*b) as f64).sum::<f64>() / src.len() as f64
        };
        let fast = err(&encode_jpeg_fast(&img, 94).unwrap());
        let old = err(&crate::encode_jpeg(&img, 94).unwrap());
        assert!(fast <= old * 1.05 + 0.05, "fast {fast} against old {old}");
    }

    #[test]
    fn the_fast_frame_is_full_chroma_baseline_with_the_srgb_profile() {
        let bytes = encode_jpeg_fast(&frame(64, 48), 94).unwrap();
        // SOF0 (baseline), three components, every sampling factor 1x1.
        let sof = bytes.windows(2).position(|w| w == [0xFF, 0xC0]).expect("a baseline SOF0");
        assert_eq!(bytes[sof + 9], 3);
        for c in 0..3 {
            assert_eq!(bytes[sof + 11 + c * 3], 0x11, "component {c} is subsampled");
        }
        assert!(!bytes.windows(2).any(|w| w == [0xFF, 0xC2]), "progressive");
        let icc = bytes.windows(12).position(|w| w == b"ICC_PROFILE\0").expect("the ICC segment");
        assert_eq!(&bytes[icc - 4..icc - 2], &[0xFF, 0xE2]);
        let profile = icc::srgb_profile();
        assert_eq!(&bytes[icc + 14..icc + 14 + profile.len()], profile);
        // The decoder the webview stands in for reads it as sRGB.
        let mut dec = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(&bytes)).unwrap();
        use image::ImageDecoder;
        assert_eq!(dec.icc_profile().unwrap().as_deref(), Some(profile));
    }

    #[test]
    fn the_quality_is_honored_and_clamped() {
        let img = frame(256, 256);
        let lo = encode_jpeg_fast(&img, 60).unwrap();
        let hi = encode_jpeg_fast(&img, 94).unwrap();
        assert!(lo.len() < hi.len());
        assert_eq!(encode_jpeg_fast(&img, 0).unwrap(), encode_jpeg_fast(&img, 1).unwrap());
    }

    #[test]
    fn an_empty_frame_is_refused_not_encoded() {
        assert!(encode_jpeg_fast(&ImageBuf::new(0, 0), 94).is_err());
    }

    #[test]
    fn a_libjpeg_error_comes_back_as_an_error_not_an_exit() {
        // Past the guard above, libjpeg itself refuses an empty image
        // (JERR_EMPTY_IMAGE) through error_exit, whose default handler
        // would end the process.
        let e = compress(&[], 0, 0, 94).unwrap_err().to_string();
        assert!(e.contains("libjpeg error"), "{e}");
        // And the encoder is whole afterwards.
        assert!(encode_jpeg_fast(&frame(16, 16), 94).is_ok());
    }
}
