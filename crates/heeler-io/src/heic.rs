//! HEIC/HEIF decode through the operating system's own codecs.
//!
//! The deliberate decision (2026-08-23): "I would prefer zero exposure. I am not [a
//! large software company]." Shipping an HEVC decoder of our own (libheif + libde265)
//! would put a one-person company inside the HEVC patent pools' blast radius; the OS
//! vendors have already licensed those codecs, so decoding through THEIR frameworks
//! rides the user's own platform license and we ship no HEVC code at all.
//!
//! macOS: ImageIO, below. The thumbnail-with-transform trick asks for
//! a "thumbnail" at unlimited size, which is a full decode with the
//! EXIF orientation already applied, so no second orientation pass.
//! Ten-bit sources quantize through an 8-bit context for now; noted,
//! not hidden.
//!
//! Windows: WIC, which decodes HEIF only when Microsoft's HEVC and
//! HEIF extensions are installed. Written and tested on a Windows box
//! with them present. A machine without them falls out of
//! CreateDecoderFromStream as None, so HEIC there reads as
//! unsupported rather than as an error.
//!
//! Linux: no OS codec story; unsupported.

use heeler_engine::ImageBuf;

/// Whether these bytes are an ISO-BMFF HEIF container.
pub fn is_heif(bytes: &[u8]) -> bool {
    if bytes.len() < 12 || &bytes[4..8] != b"ftyp" {
        return false;
    }
    matches!(&bytes[8..12], b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1")
}

#[cfg(target_os = "macos")]
pub fn decode_heif(bytes: &[u8]) -> Option<ImageBuf> {
    macos::decode_at(bytes, None)
}

/// Native reduced decode where the platform supports it. Admission happens
/// before ImageIO creates pixels, so a smaller tier does not first decode full.
#[cfg(target_os = "macos")]
pub fn decode_thumbnail(bytes: &[u8], edge: usize) -> Option<ImageBuf> {
    macos::decode_at(bytes, Some(edge))
}
#[cfg(target_os = "windows")]
pub fn decode_thumbnail(bytes: &[u8], edge: usize) -> Option<ImageBuf> { windows_wic::decode_at(bytes, Some(edge)) }
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn decode_thumbnail(_bytes: &[u8], _edge: usize) -> Option<ImageBuf> { None }

#[cfg(target_os = "windows")]
pub fn decode_heif(bytes: &[u8]) -> Option<ImageBuf> {
    windows_wic::decode_at(bytes, None)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn decode_heif(_bytes: &[u8]) -> Option<ImageBuf> {
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use super::ImageBuf;
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }

    #[link(name = "ImageIO", kind = "framework")]
    extern "C" {
        fn CGImageSourceCreateWithData(data: *const c_void, options: *const c_void) -> *mut c_void;
        fn CGImageSourceCreateThumbnailAtIndex(
            source: *mut c_void,
            index: usize,
            options: *const c_void,
        ) -> *mut c_void;
        fn CGImageSourceCopyPropertiesAtIndex(source: *mut c_void, index: usize, options: *const c_void) -> *const c_void;
        static kCGImagePropertyPixelWidth: *const c_void;
        static kCGImagePropertyPixelHeight: *const c_void;
        static kCGImageSourceCreateThumbnailWithTransform: *const c_void;
        static kCGImageSourceCreateThumbnailFromImageAlways: *const c_void;
        static kCGImageSourceThumbnailMaxPixelSize: *const c_void;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGImageGetWidth(image: *mut c_void) -> usize;
        fn CGImageGetHeight(image: *mut c_void) -> usize;
        fn CGImageRelease(image: *mut c_void);
        fn CGImageGetColorSpace(image: *mut c_void) -> *mut c_void;
        fn CGColorSpaceCopyICCData(space: *mut c_void) -> *const core_foundation::data::__CFData;
        fn CGImageCreateCopyWithColorSpace(image: *mut c_void, space: *mut c_void) -> *mut c_void;
        fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
        fn CGColorSpaceRelease(space: *mut c_void);
        static kCGColorSpaceSRGB: *const c_void;
        fn CGBitmapContextCreate(
            data: *mut c_void,
            width: usize,
            height: usize,
            bits_per_component: usize,
            bytes_per_row: usize,
            space: *mut c_void,
            bitmap_info: u32,
        ) -> *mut c_void;
        fn CGContextDrawImage(ctx: *mut c_void, rect: CGRect, image: *mut c_void);
        fn CGContextRelease(ctx: *mut c_void);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(cf: *const c_void);
        fn CFDictionaryGetValue(dict: *const c_void, key: *const c_void) -> *const c_void;
        fn CFNumberGetValue(number: *const c_void, kind: isize, value: *mut c_void) -> bool;
    }

    /// kCGImageAlphaPremultipliedLast: RGBA byte order, photo alpha is
    /// opaque so premultiplication changes nothing.
    const BITMAP_RGBA8: u32 = 1;

    pub(super) fn decode_at(bytes: &[u8], edge: Option<usize>) -> Option<ImageBuf> {
        unsafe {
            let _input_job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(
                heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(bytes.len(), 2, 1, 1)), "native image input"));
            let data = CFData::from_buffer(bytes);
            let source = CGImageSourceCreateWithData(data.as_concrete_TypeRef() as *const c_void, std::ptr::null());
            if source.is_null() {
                return None;
            }
            let props = CGImageSourceCopyPropertiesAtIndex(source, 0, std::ptr::null());
            if props.is_null() { CFRelease(source); return None; }
            let dimension = |key| {
                let number = CFDictionaryGetValue(props, key);
                let mut n = 0i64;
                if number.is_null() || !CFNumberGetValue(number, 4, &mut n as *mut _ as _) || n <= 0 { None }
                else { usize::try_from(n).ok() }
            };
            let dims = dimension(kCGImagePropertyPixelWidth).zip(dimension(kCGImagePropertyPixelHeight));
            CFRelease(props);
            let Some((width, height)) = dims else { CFRelease(source); return None; };
            let max_edge = edge.unwrap_or(width.max(height)).max(1);
            let scale = (max_edge as f64 / width.max(height) as f64).min(1.0);
            let (admitted_w, admitted_h) = ((width as f64 * scale).ceil() as usize, (height as f64 * scale).ceil() as usize);
            let admission = (|| {
                let size = heeler_engine::memory::sum([heeler_engine::memory::bytes(admitted_w, admitted_h, 1, 32)?, heeler_engine::memory::bytes(width, height, 1, 16)?])?;
                let needed = heeler_engine::memory::sum([size, bytes.len(), bytes.len()])?;
                heeler_engine::memory::Job::admit(needed, "native image decode and conversion")
            })();
            let _job = match admission { Ok(j) => j, Err(e) => { CFRelease(source); heeler_engine::memory::or_unwind(Err(e)) } };
            // Full-size decode with the orientation transform applied:
            // an unlimited "thumbnail" is the documented spelling.
            let options = CFDictionary::from_CFType_pairs(&[
                (
                    CFString::wrap_under_get_rule(kCGImageSourceCreateThumbnailWithTransform as _).as_CFType(),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kCGImageSourceCreateThumbnailFromImageAlways as _).as_CFType(),
                    CFBoolean::true_value().as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kCGImageSourceThumbnailMaxPixelSize as _).as_CFType(),
                    CFNumber::from(max_edge as i64).as_CFType(),
                ),
            ]);
            let image = CGImageSourceCreateThumbnailAtIndex(
                source,
                0,
                options.as_concrete_TypeRef() as *const c_void,
            );
            CFRelease(source as *const c_void);
            if image.is_null() {
                return None;
            }
            let (w, h) = (CGImageGetWidth(image), CGImageGetHeight(image));
            if w == 0 || h == 0 || w.max(h) > admitted_w.max(admitted_h) || w.min(h) > admitted_w.min(admitted_h) {
                CGImageRelease(image);
                return None;
            }
            let allocated = heeler_engine::memory::bytes(w, h, 4, 1)
                .and_then(|n| heeler_engine::memory::vector(n, 0u8, "native RGBA pixels"));
            let mut rgba = match allocated { Ok(v) => v, Err(e) => { CGImageRelease(image); heeler_engine::memory::or_unwind(Err(e)) } };
            let embedded = crate::input_color::heif_profile(bytes);
            let profile = match embedded {
                Ok(Some(p)) => Ok(Some(p)),
                Err(e) if super::is_heif(bytes) => Err(e),
                _ => {
                    let source_space = CGImageGetColorSpace(image);
                    let data = if source_space.is_null() { std::ptr::null() } else { CGColorSpaceCopyICCData(source_space) };
                    if data.is_null() { Ok(None) } else {
                        let data = CFData::wrap_under_create_rule(data);
                        if data.bytes().len() > 4 * 1024 * 1024 { Err("HEIF ICC profile too large") }
                        else { Ok(Some(data.bytes().to_vec())) }
                    }
                }
            };
            let space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            // Relabel numeric samples before drawing so CoreGraphics does not
            // perform a hidden conversion before our shared ingestion seam.
            let samples = if crate::input_color::legacy_raw() { image } else {
                let copy = CGImageCreateCopyWithColorSpace(image, space);
                CGImageRelease(image);
                copy
            };
            if samples.is_null() { CGColorSpaceRelease(space); return None; }
            let image = samples;
            let ctx = CGBitmapContextCreate(
                rgba.as_mut_ptr() as *mut c_void,
                w,
                h,
                8,
                w * 4,
                space,
                BITMAP_RGBA8,
            );
            if ctx.is_null() {
                CGColorSpaceRelease(space);
                CGImageRelease(image);
                return None;
            }
            CGContextDrawImage(
                ctx,
                CGRect {
                    origin: CGPoint { x: 0.0, y: 0.0 },
                    size: CGSize { width: w as f64, height: h as f64 },
                },
                image,
            );
            CGContextRelease(ctx);
            CGColorSpaceRelease(space);
            CGImageRelease(image);

            let mut out = ImageBuf::new(w, h);
            for p in 0..w * h {
                out.data[p * 4 + 3] = rgba[p * 4 + 3] as f32 / 255.0;
                for c in 0..3 { out.data[p * 4 + c] = rgba[p * 4 + c] as f32 / 255.0; }
            }
            // The bitmap context gives premultiplied samples; ICC operates on
            // straight RGB. Transparent pixels remain transparent black.
            for px in out.data.chunks_exact_mut(4) {
                if px[3] > 0.0 { for c in 0..3 { px[c] /= px[3]; } }
            }
            crate::input_color::ingest(&mut out, profile.as_ref().map(|p| p.as_deref()).map_err(|e| *e));
            Some(out)
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_wic {
    //! WIC, which decodes HEIF only when the user has Microsoft's
    //! HEVC/HEIF extensions installed. That is the whole point: the
    //! HEVC license is Microsoft's, the codec is theirs, and a machine
    //! without it falls out of `CreateDecoderFromStream` as a plain
    //! None, so HEIC reads as unsupported rather than as an error.

    use super::ImageBuf;
    use windows::core::Interface;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapFrameDecode,
        IWICBitmapSource, IWICImagingFactory, WICConvertBitmapSource,
        WICDecodeMetadataCacheOnDemand, WICBitmapInterpolationModeFant,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    pub(super) fn decode_at(bytes: &[u8], edge: Option<usize>) -> Option<ImageBuf> {
        unsafe {
            // COM has to be live on this thread. Already initialized is
            // success as far as we are concerned, including the
            // RPC_E_CHANGED_MODE case where somebody else picked the
            // apartment: WIC works in either, and uninitializing theirs
            // would be rude and wrong.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
            let stream = factory.CreateStream().ok()?;
            // InitializeFromMemory borrows the buffer rather than
            // copying it, and wants it mutable, so this copy is what
            // keeps the decode inside safe territory.
            let mut buf = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(bytes.len(), 0u8, "WIC input"));
            buf.copy_from_slice(bytes);
            stream.InitializeFromMemory(&mut buf).ok()?;

            // The one call that fails on a machine without the
            // extension. Nothing below it is reached there.
            let decoder = factory
                .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
                .ok()?;
            let frame: IWICBitmapFrameDecode = decoder.GetFrame(0).ok()?;
            let orientation = exif_orientation(&frame);
            let embedded = if super::is_heif(bytes) {
                crate::input_color::heif_profile(bytes)
            } else if bytes.starts_with(&[255, 216]) {
                crate::input_color::jpeg_profile(&mut std::io::Cursor::new(bytes))
            } else {
                Ok(None)
            };
            let profile = match embedded {
                Ok(Some(p)) => Ok(Some(p)),
                Err(e) => Err(e),
                Ok(None) => {
                    let mut count = 0;
                    let context = factory.CreateColorContext().ok()?;
                    let mut contexts = [Some(context.clone())];
                    if frame.GetColorContexts(&mut contexts, &mut count).is_ok() && count > 0 {
                        let mut size = 0;
                        if context.GetProfileBytes(&mut [], &mut size).is_ok() && size > 0 && size <= 4 * 1024 * 1024 {
                            let mut p = vec![0; size as usize];
                            context.GetProfileBytes(&mut p, &mut size).map(|_| Some(p)).map_err(|_| "cannot read HEIF ICC profile")
                        } else { Ok(None) }
                    } else { Ok(None) }
                }
            };

            let (mut native_w, mut native_h) = (0u32, 0u32);
            frame.GetSize(&mut native_w, &mut native_h).ok()?;
            if native_w == 0 || native_h == 0 { return None; }
            let scale = edge.map(|e| (e as f64 / native_w.max(native_h) as f64).min(1.0)).unwrap_or(1.0);
            let (w, h) = ((native_w as f64 * scale).ceil() as u32, (native_h as f64 * scale).ceil() as u32);
            let needed = heeler_engine::memory::or_unwind(heeler_engine::memory::sum([
                heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(native_w as usize, native_h as usize, 1, 16)),
                heeler_engine::memory::or_unwind(heeler_engine::memory::bytes(w as usize, h as usize, 1, 32)), bytes.len(), bytes.len()]));
            let _job = heeler_engine::memory::or_unwind(heeler_engine::memory::Job::admit(needed, "WIC decode and orientation"));
            let source: IWICBitmapSource = if scale < 1.0 {
                let scaler = factory.CreateBitmapScaler().ok()?;
                scaler.Initialize(&frame, w, h, WICBitmapInterpolationModeFant).ok()?;
                scaler.cast().ok()?
            } else { frame.cast().ok()? };
            let converted = WICConvertBitmapSource(&GUID_WICPixelFormat32bppRGBA, &source).ok()?;
            let stride = w.checked_mul(4)?;
            let len = (stride as usize).checked_mul(h as usize)?;
            let mut rgba = heeler_engine::memory::or_unwind(heeler_engine::memory::vector(len, 0u8, "WIC RGBA pixels"));
            converted.CopyPixels(std::ptr::null(), stride, &mut rgba).ok()?;

            let (w, h) = (w as usize, h as usize);
            let mut out = ImageBuf::new(w, h);
            for p in 0..w * h {
                out.data[p * 4 + 3] = rgba[p * 4 + 3] as f32 / 255.0;
                for c in 0..3 { out.data[p * 4 + c] = rgba[p * 4 + c] as f32 / 255.0; }
            }
            crate::input_color::ingest(&mut out, profile.as_ref().map(|p| p.as_deref()).map_err(|e| *e));
            // WIC hands back the stored pixels; the Exif quarter-turns
            // are ours to apply, the same way every other format in this
            // crate gets them. macOS asks ImageIO to do it during the
            // decode, so both platforms end up upright by the time
            // anybody sees the buffer.
            Some(crate::apply_orientation(out, orientation))
        }
    }

    /// The Exif orientation WIC found, or 1 when there is none.
    ///
    /// Two query paths because HEIF files disagree about where the Exif
    /// block hangs: phones write it under `/ifd`, some transcoders nest
    /// it under `/app1`. Anything unreadable is an upright photograph
    /// as far as this is concerned, which is the safe way to be wrong.
    unsafe fn exif_orientation(frame: &IWICBitmapFrameDecode) -> u16 {
        use windows::core::{w, PROPVARIANT};

        let Ok(reader) = frame.GetMetadataQueryReader() else {
            return 1;
        };
        for path in [w!("/ifd/{ushort=274}"), w!("/app1/ifd/{ushort=274}")] {
            // PROPVARIANT frees itself on drop, and the u16 conversion
            // is the crate's own, so a tag stored as something other
            // than a ushort still reads rather than being missed.
            let mut value = PROPVARIANT::new();
            if reader.GetMetadataByName(path, &mut value).is_err() {
                continue;
            }
            if let Ok(o) = u16::try_from(&value) {
                if (1..=8).contains(&o) {
                    return o;
                }
            }
        }
        1
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    /// Round trip through the OS: sips (always present on macOS)
    /// encodes a small PNG to HEIC, and the decoder brings it back at
    /// the right size and roughly the right color.
    #[test]
    fn a_sips_made_heic_decodes_to_the_same_picture() {
        let dir = tempfile::tempdir().unwrap();
        let png_path = dir.path().join("t.png");
        let heic_path = dir.path().join("t.heic");
        let img = heeler_engine::ImageBuf::filled(64, 32, [0.5, 0.2, 0.1, 1.0]);
        std::fs::write(&png_path, crate::encode_png(&img).unwrap()).unwrap();
        let ok = std::process::Command::new("sips")
            .args(["-s", "format", "heic"])
            .arg(&png_path)
            .arg("--out")
            .arg(&heic_path)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            // A build box without HEIC write support is not a failure
            // of this code; the decode path is still covered wherever
            // sips can encode.
            eprintln!("sips could not write HEIC here; skipping");
            return;
        }
        let bytes = std::fs::read(&heic_path).unwrap();
        assert!(is_heif(&bytes), "sips output should sniff as HEIF");
        let out = decode_heif(&bytes).expect("OS decode");
        assert_eq!((out.width, out.height), (64, 32));
        let px = out.pixel(32, 16);
        assert!((px[0] - 0.5).abs() < 0.05, "r {}", px[0]);
        assert!((px[1] - 0.2).abs() < 0.05, "g {}", px[1]);
        assert!((px[2] - 0.1).abs() < 0.05, "b {}", px[2]);
    }

    #[test]
    fn sniffing_rejects_non_heif() {
        assert!(!is_heif(b"not a container at all"));
        assert!(!is_heif(&[0, 0, 0, 24, b'f', b't', b'y', b'p', b'c', b'r', b'x', b' ']));
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    use windows::core::HSTRING;
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatHeif, GUID_WICPixelFormat32bppRGBA,
        GUID_WICPixelFormat32bppBGR, GUID_WICPixelFormat32bppBGRA,
        GUID_WICPixelFormat32bppPBGRA, IWICBitmapFrameEncode, IWICImagingFactory,
        WICBitmapEncoderNoCache,
    };
    use windows::Win32::Foundation::GENERIC_WRITE;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    /// Writes a solid patch to HEIC with the OS encoder: the Windows
    /// answer to what `sips` does in the macOS test above. None when
    /// this machine has no HEIF encoder, which is a fact about the
    /// machine rather than a failure of the decoder.
    unsafe fn os_encode_heic(path: &std::path::Path, w: u32, h: u32, rgba: &[u8]) -> Option<()> {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER).ok()?;
        let stream = factory.CreateStream().ok()?;
        stream
            .InitializeFromFilename(&HSTRING::from(path.as_os_str()), GENERIC_WRITE.0)
            .ok()?;
        let encoder = factory
            .CreateEncoder(&GUID_ContainerFormatHeif, std::ptr::null())
            .ok()?;
        encoder.Initialize(&stream, WICBitmapEncoderNoCache).ok()?;
        let mut frame: Option<IWICBitmapFrameEncode> = None;
        encoder.CreateNewFrame(&mut frame, std::ptr::null_mut()).ok()?;
        let frame = frame?;
        frame.Initialize(None).ok()?;
        frame.SetSize(w, h).ok()?;
        // SetPixelFormat is in/out: WIC answers with the format it will
        // actually take, which for HEIF is BGRA whatever is asked for.
        // Writing RGBA bytes into that silently swaps red and blue, and
        // the test then blames the decoder for the encoder's choice.
        let mut format = GUID_WICPixelFormat32bppRGBA;
        frame.SetPixelFormat(&mut format).ok()?;
        // BGR order in a 32-bit pixel, whichever spelling it picks.
        let bgr_order = format == GUID_WICPixelFormat32bppBGRA
            || format == GUID_WICPixelFormat32bppBGR
            || format == GUID_WICPixelFormat32bppPBGRA;
        let pixels = if bgr_order {
            let mut bgra = rgba.to_vec();
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            bgra
        } else {
            rgba.to_vec()
        };
        frame.WritePixels(h, w * 4, &pixels).ok()?;
        frame.Commit().ok()?;
        encoder.Commit().ok()?;
        drop(stream);
        Some(())
    }

    /// Round trip through Windows' own codec: the HEIF extension
    /// encodes a patch, and the decoder brings it back at the right
    /// size and roughly the right color. Mirrors the macOS sips test.
    #[test]
    fn an_os_written_heic_decodes_to_the_same_picture() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.heic");
        // sRGB bytes that land near linear 0.5 / 0.2 / 0.1.
        let (w, h) = (64u32, 32u32);
        let mut rgba = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..w * h {
            rgba.extend_from_slice(&[188, 124, 89, 255]);
        }
        let wrote = unsafe { os_encode_heic(&path, w, h, &rgba) }.is_some();
        if !wrote || !path.exists() {
            // No HEIF encoder here. The decoder is not on trial for
            // that, and the codec-absent path is covered below.
            eprintln!("no OS HEIF encoder on this machine; skipping the round trip");
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        assert!(is_heif(&bytes), "the OS encoder should write an HEIF container");

        let Some(out) = decode_heif(&bytes) else {
            // Encoder present, decoder absent is not a combination
            // Microsoft ships, but saying so beats an unexplained panic.
            panic!("this machine encoded HEIF but would not decode it");
        };
        assert_eq!((out.width, out.height), (64, 32));
        let px = out.pixel(32, 16);
        assert!((px[0] - 0.5).abs() < 0.05, "r {}", px[0]);
        assert!((px[1] - 0.2).abs() < 0.05, "g {}", px[1]);
        assert!((px[2] - 0.1).abs() < 0.05, "b {}", px[2]);
        assert!((px[3] - 1.0).abs() < 0.01, "a {}", px[3]);
    }

    /// The graceful half of the contract: rubbish that sniffs as HEIF
    /// gets a None out of the OS rather than a panic or a hang. This is
    /// the same road a machine without the extension takes.
    #[test]
    fn a_broken_container_declines_instead_of_exploding() {
        let mut bytes = vec![0u8; 64];
        bytes[4..8].copy_from_slice(b"ftyp");
        bytes[8..12].copy_from_slice(b"heic");
        assert!(is_heif(&bytes), "the sniff is deliberately cheap");
        assert!(decode_heif(&bytes).is_none());
    }
}


#[cfg(all(test, target_os = "windows"))]
mod native_jpeg_tests {
    #[test]
    fn a_native_jpeg_thumbnail_uses_its_embedded_transfer_curve() {
        let image = heeler_engine::ImageBuf::filled(128, 64, [0.2, 0.4, 0.6, 1.0]);
        let mut jpeg = crate::encode_jpeg(&image, 95).unwrap();
        let start = jpeg.windows(12).position(|b| b == b"ICC_PROFILE\0").unwrap() + 14;
        let profile = &mut jpeg[start..start + crate::srgb_profile().len()];
        let tags = u32::from_be_bytes(profile[128..132].try_into().unwrap()) as usize;
        for tag in 0..tags {
            let at = 132 + tag * 12;
            if &profile[at..at + 4] != b"rTRC" { continue; }
            let offset = u32::from_be_bytes(profile[at + 4..at + 8].try_into().unwrap()) as usize;
            let count = u32::from_be_bytes(profile[offset + 8..offset + 12].try_into().unwrap()) as usize;
            for i in 0..count {
                profile[offset + 12 + i * 2..offset + 14 + i * 2].copy_from_slice(&((i as f64 / (count - 1) as f64 * 65535.0).round() as u16).to_be_bytes());
            }
        }
        let reference = crate::decode_bytes(&jpeg).unwrap();
        let native = super::decode_thumbnail(&jpeg, 64).expect("Windows WIC supports JPEG");
        for c in 0..3 { assert!((native.pixel(8, 8)[c] - reference.pixel(16, 16)[c]).abs() < 0.01); }
    }
}
