//! An export's frame put together band by band, in the samples its
//! encoder takes (the memory ceiling, Phase 3): a banded render
//! (heeler_engine::banded) hands its rows over a band at a time, and
//! rather than gather them into an f32 frame, 16 bytes a pixel, the sink
//! converts each band as the encoder converts each pixel and keeps only
//! that: 3 bytes a pixel for a JPEG, 4 for an 8-bit PNG or a WebP, 8 for
//! a 16-bit PNG or TIFF. The file is the whole frame's encode, byte for
//! byte: the conversions are the encoders' own, pixel by pixel, and the
//! encode is the same function the whole-frame encoders end in.
//!
//! The two encoders that read the whole frame before converting keep
//! what that needs: the 16-bit TIFF writes an alpha only when some pixel
//! has one, so its sink keeps four samples and drops the fourth at the
//! end when none did; the DNG scales by the frame's brightest sample, so
//! its sink keeps scene-linear RGB (12 bytes a pixel) and the peak as the
//! bands go, and quantizes at the end.

use heeler_engine::memory;
use heeler_engine::ImageBuf;

use crate::{linear_to_srgb, srgb_u8, Exif, IoError, TiffExportOptions};

/// What a sink writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkFormat {
    Jpeg,
    Png8,
    Png16,
    Webp,
    /// The 16-bit TIFF export (encode_tiff16_export).
    Tiff16,
    /// The scene-linear DNG (encode_dng_with_xmp).
    Dng,
}

impl SinkFormat {
    /// The bytes a pixel a sink of this format keeps, for admission.
    pub fn bytes_per_pixel(self) -> usize {
        match self {
            SinkFormat::Jpeg => 3,
            SinkFormat::Png8 | SinkFormat::Webp => 4,
            SinkFormat::Png16 | SinkFormat::Tiff16 => 8,
            SinkFormat::Dng => 12,
        }
    }
}

/// A frame `width` by `height` arriving top to bottom, kept as `format`
/// will encode it.
pub struct BandSink {
    format: SinkFormat,
    width: usize,
    height: usize,
    rows: usize,
    samples: Vec<u8>,
    linear: Vec<f32>,
    alpha: bool,
    peak: f32,
}

impl BandSink {
    pub fn new(format: SinkFormat, width: usize, height: usize) -> Result<BandSink, IoError> {
        if width == 0 || height == 0 || width > u32::MAX as usize || height > u32::MAX as usize {
            return Err(IoError::UnsupportedFormat);
        }
        let (samples, linear) = match format {
            SinkFormat::Dng => (Vec::new(), memory::vector(memory::bytes(width, height, 3, 1)?, 0.0f32, "export samples")?),
            _ => (memory::vector(memory::bytes(width, height, format.bytes_per_pixel(), 1)?, 0u8, "export samples")?, Vec::new()),
        };
        Ok(BandSink { format, width, height, rows: 0, samples, linear, alpha: false, peak: 0.0 })
    }

    /// The next band's rows, which must start where the last band ended.
    pub fn put(&mut self, y0: usize, band: &ImageBuf) -> Result<(), IoError> {
        use rayon::prelude::*;
        if y0 != self.rows || band.width != self.width || self.rows + band.height > self.height {
            return Err(IoError::Unsupported(format!(
                "a band of {} by {} at row {y0} does not follow row {} of a {} by {} frame",
                band.width, band.height, self.rows, self.width, self.height
            )));
        }
        let w = self.width;
        let px = |rows: &mut [u8], stride: usize, f: &(dyn Fn(&[f32], &mut [u8]) + Sync)| {
            rows.par_chunks_mut(w * stride).zip(band.data.par_chunks(w * 4)).for_each(|(row, src)| {
                for (o, s) in row.chunks_exact_mut(stride).zip(src.chunks_exact(4)) {
                    f(s, o);
                }
            });
        };
        let at = y0 * w;
        let end = (y0 + band.height) * w;
        match self.format {
            // to_srgb_u8, without and with the alpha.
            SinkFormat::Jpeg => px(&mut self.samples[at * 3..end * 3], 3, &|s, o| {
                for c in 0..3 {
                    o[c] = srgb_u8(s[c]);
                }
            }),
            SinkFormat::Png8 | SinkFormat::Webp => px(&mut self.samples[at * 4..end * 4], 4, &|s, o| {
                for c in 0..3 {
                    o[c] = srgb_u8(s[c]);
                }
                o[3] = (s[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }),
            // encode_png16's samples, in native byte order.
            SinkFormat::Png16 => px(&mut self.samples[at * 8..end * 8], 8, &|s, o| {
                for c in 0..3 {
                    let v = linear_to_srgb(s[c]).clamp(0.0, 1.0);
                    o[c * 2..c * 2 + 2].copy_from_slice(&((v * 65535.0).round() as u16).to_ne_bytes());
                }
                let a = (s[3].clamp(0.0, 1.0) * 65535.0).round() as u16;
                o[6..8].copy_from_slice(&a.to_ne_bytes());
            }),
            // srgb16_pixels with the alpha always kept; dropped at the end
            // when no pixel had one.
            SinkFormat::Tiff16 => {
                px(&mut self.samples[at * 8..end * 8], 8, &|s, o| {
                    for c in 0..3 {
                        let v = linear_to_srgb(s[c].clamp(0.0, 1.0));
                        o[c * 2..c * 2 + 2].copy_from_slice(&((v * 65535.0).round() as u16).to_le_bytes());
                    }
                    let a = s[3].clamp(0.0, 1.0);
                    o[6..8].copy_from_slice(&((a * 65535.0).round() as u16).to_le_bytes());
                });
                self.alpha |= band.data.par_chunks_exact(4).any(|px| px[3] < 1.0);
            }
            // The scene-linear RGB, and linear_headroom's peak as it goes.
            SinkFormat::Dng => {
                let linear = &mut self.linear[at * 3..end * 3];
                for (o, s) in linear.chunks_exact_mut(3).zip(band.data.chunks_exact(4)) {
                    o.copy_from_slice(&s[..3]);
                }
                self.peak = band.data.chunks_exact(4).flat_map(|px| px[..3].iter()).fold(self.peak, |a, &b| if b > a { b } else { a });
            }
        }
        self.rows += band.height;
        Ok(())
    }

    fn complete(&self) -> Result<(), IoError> {
        if self.rows == self.height {
            Ok(())
        } else {
            Err(IoError::Unsupported(format!("the frame has {} of its {} rows", self.rows, self.height)))
        }
    }

    /// The JPEG, at `quality` 1 to 100.
    pub fn jpeg(self, quality: u8) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Jpeg)?;
        crate::jpeg_from_rgb8(&self.samples, self.width, self.height, quality)
    }

    /// The 8-bit PNG.
    pub fn png8(self) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Png8)?;
        crate::png_from_samples(&self.samples, self.width, self.height, image::ExtendedColorType::Rgba8)
    }

    /// The 16-bit PNG.
    pub fn png16(self) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Png16)?;
        crate::png_from_samples(&self.samples, self.width, self.height, image::ExtendedColorType::Rgba16)
    }

    /// The WebP, at `quality` 1 to 100.
    pub fn webp(self, quality: u8) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Webp)?;
        crate::webp_from_rgba8(&self.samples, self.width, self.height, quality)
    }

    /// The 16-bit TIFF export.
    pub fn tiff16(mut self, options: TiffExportOptions<'_>) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Tiff16)?;
        crate::bake::strip_len(self.width, self.height)?;
        if !self.alpha {
            // Six bytes a pixel, in place: each pixel moves down to where
            // srgb16_pixels without an alpha writes it.
            let n = self.width * self.height;
            for i in 0..n {
                self.samples.copy_within(i * 8..i * 8 + 6, i * 6);
            }
            self.samples.truncate(n * 6);
        }
        crate::bake::tiff16_export_from_pixels(&self.samples, self.width, self.height, self.alpha, options.exif, options.xmp, options.dpi)
    }

    /// The scene-linear DNG.
    pub fn dng(self, exif: Option<&Exif>, xmp: Option<&str>) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Dng)?;
        crate::bake::strip_len(self.width, self.height)?;
        let (scale, stops) = if !self.peak.is_finite() || self.peak <= 1.0 { (1.0, 0.0) } else { (self.peak, self.peak.log2()) };
        let mut pixels = memory::vector(memory::bytes(self.width, self.height, 6, 1)?, 0u8, "DNG samples")?;
        pixels.clear();
        for v in &self.linear {
            let v = (v / scale).clamp(0.0, 1.0);
            pixels.extend_from_slice(&((v * 65535.0).round() as u16).to_le_bytes());
        }
        drop(self.linear);
        crate::bake::dng_from_pixels(&pixels, self.width, self.height, stops, exif, xmp, None)
    }

    fn expect(&self, format: SinkFormat) -> Result<(), IoError> {
        if self.format != format {
            return Err(IoError::Unsupported(format!("a {:?} sink cannot write a {format:?}", self.format)));
        }
        self.complete()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with values past white, below black, an alpha that varies
    /// or does not, at a size no band divides.
    fn frame(w: usize, h: usize, opaque: bool) -> ImageBuf {
        let mut img = ImageBuf::new(w, h);
        for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
            let (x, y) = ((i % w) as f32 / w as f32, (i / w) as f32 / h as f32);
            px.copy_from_slice(&[1.6 * x * y - 0.05, 0.7 * y, 0.9 * (1.0 - x), if opaque { 1.0 } else { 0.3 + 0.7 * x }]);
        }
        img
    }

    fn bands(img: &ImageBuf, rows: usize) -> Vec<(usize, ImageBuf)> {
        (0..img.height)
            .step_by(rows)
            .map(|y| {
                let h = rows.min(img.height - y);
                (y, ImageBuf { width: img.width, height: h, data: img.data[y * img.width * 4..(y + h) * img.width * 4].to_vec() })
            })
            .collect()
    }

    fn sink(format: SinkFormat, img: &ImageBuf) -> BandSink {
        let mut s = BandSink::new(format, img.width, img.height).unwrap();
        for (y, b) in bands(img, 7) {
            s.put(y, &b).unwrap();
        }
        s
    }

    /// Fed band by band, every format writes the whole-frame encoder's
    /// file byte for byte, with an alpha and without, and a DNG past white.
    #[test]
    fn a_band_sink_writes_the_whole_frames_file() {
        for opaque in [true, false] {
            let img = frame(53, 38, opaque);
            assert_eq!(sink(SinkFormat::Jpeg, &img).jpeg(88).unwrap(), crate::encode_jpeg(&img, 88).unwrap(), "jpeg");
            assert_eq!(sink(SinkFormat::Png8, &img).png8().unwrap(), crate::encode_png(&img).unwrap(), "png8");
            assert_eq!(sink(SinkFormat::Png16, &img).png16().unwrap(), crate::encode_png16(&img).unwrap(), "png16");
            assert_eq!(sink(SinkFormat::Webp, &img).webp(80).unwrap(), crate::encode_webp(&img, 80).unwrap(), "webp");
            assert_eq!(
                sink(SinkFormat::Tiff16, &img).tiff16(Default::default()).unwrap(),
                crate::encode_tiff16_export(&img, Default::default()).unwrap(),
                "tiff16, opaque {opaque}"
            );
            assert_eq!(sink(SinkFormat::Dng, &img).dng(None, None).unwrap(), crate::encode_dng_with_xmp(&img, None, None).unwrap(), "dng");
        }
    }

    /// A band out of order, or a frame short of rows, is an error, not a
    /// file.
    #[test]
    fn a_sink_takes_its_bands_in_order_and_whole() {
        let img = frame(20, 30, true);
        let parts = bands(&img, 7);
        let mut s = BandSink::new(SinkFormat::Jpeg, 20, 30).unwrap();
        assert!(s.put(parts[1].0, &parts[1].1).is_err());
        s.put(parts[0].0, &parts[0].1).unwrap();
        assert!(s.jpeg(90).is_err());
    }
}
