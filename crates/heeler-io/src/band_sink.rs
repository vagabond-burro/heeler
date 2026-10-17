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

use std::collections::HashMap;

use heeler_engine::banded::{self, BandedReport};
use heeler_engine::memory;
use heeler_engine::{EngineError, ImageBuf, SourceImage, Value};
use heeler_graph::Graph;

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

    /// Peak samples, encoder scratch and growing output. These use the
    /// whole-frame encoders' admission bounds, which include samples.
    pub fn encoding_bytes(self, width: usize, height: usize) -> Result<usize, IoError> {
        let per_pixel = match self {
            SinkFormat::Jpeg => 13,
            SinkFormat::Png8 => 22,
            SinkFormat::Webp => 8,
            SinkFormat::Png16 => 48,
            SinkFormat::Tiff16 | SinkFormat::Dng => 32,
        };
        Ok(memory::sum([memory::bytes(width, height, 1, per_pixel)?, 64 * 1024])?)
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
        let _job = memory::Job::admit(self.format.encoding_bytes(self.width, self.height)?, "streamed image encoding and output")?;
        crate::jpeg_from_rgb8(&self.samples, self.width, self.height, quality)
    }

    /// The 8-bit PNG.
    pub fn png8(self) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Png8)?;
        let _job = memory::Job::admit(self.format.encoding_bytes(self.width, self.height)?, "streamed image encoding and output")?;
        crate::png_from_samples(&self.samples, self.width, self.height, image::ExtendedColorType::Rgba8)
    }

    /// The 16-bit PNG.
    pub fn png16(self) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Png16)?;
        let _job = memory::Job::admit(self.format.encoding_bytes(self.width, self.height)?, "streamed image encoding and output")?;
        crate::png_from_samples(&self.samples, self.width, self.height, image::ExtendedColorType::Rgba16)
    }

    /// The WebP, at `quality` 1 to 100.
    pub fn webp(self, quality: u8) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Webp)?;
        let _job = memory::Job::admit(self.format.encoding_bytes(self.width, self.height)?, "streamed image encoding and output")?;
        crate::webp_from_rgba8(&self.samples, self.width, self.height, quality)
    }

    /// The 16-bit TIFF export.
    pub fn tiff16(mut self, options: TiffExportOptions<'_>) -> Result<Vec<u8>, IoError> {
        self.expect(SinkFormat::Tiff16)?;
        let _job = memory::Job::admit(self.format.encoding_bytes(self.width, self.height)?, "streamed image encoding and output")?;
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
        let _job = memory::Job::admit(self.format.encoding_bytes(self.width, self.height)?, "streamed image encoding and output")?;
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

    /// The file, as `encoding` writes it.
    pub fn encode(self, encoding: Encoding<'_>) -> Result<Vec<u8>, IoError> {
        match encoding {
            Encoding::Jpeg(q) => self.jpeg(q),
            Encoding::Png8 => self.png8(),
            Encoding::Png16 => self.png16(),
            Encoding::Webp(q) => self.webp(q),
            Encoding::Tiff16(options) => self.tiff16(options),
            Encoding::Dng { exif, xmp } => self.dng(exif, xmp),
        }
    }

    /// The frame's width and height.
    pub fn size(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    fn expect(&self, format: SinkFormat) -> Result<(), IoError> {
        if self.format != format {
            return Err(IoError::Unsupported(format!("a {:?} sink cannot write a {format:?}", self.format)));
        }
        self.complete()
    }
}

/// How a streamed export is encoded: the format and what it takes.
#[derive(Clone, Copy)]
pub enum Encoding<'a> {
    /// At quality 1 to 100.
    Jpeg(u8),
    Png8,
    Png16,
    /// At quality 1 to 100.
    Webp(u8),
    Tiff16(TiffExportOptions<'a>),
    Dng { exif: Option<&'a Exif>, xmp: Option<&'a str> },
}

impl Encoding<'_> {
    /// The sink this encoding's samples are kept in.
    pub fn format(&self) -> SinkFormat {
        match self {
            Encoding::Jpeg(_) => SinkFormat::Jpeg,
            Encoding::Png8 => SinkFormat::Png8,
            Encoding::Png16 => SinkFormat::Png16,
            Encoding::Webp(_) => SinkFormat::Webp,
            Encoding::Tiff16(_) => SinkFormat::Tiff16,
            Encoding::Dng { .. } => SinkFormat::Dng,
        }
    }
}

/// An engine error as the sink's: a refusal stays a refusal.
fn engine_error(e: EngineError) -> IoError {
    match e {
        EngineError::Memory(m) => IoError::Memory(m),
        e => IoError::Unsupported(e.to_string()),
    }
}

/// The bytes a sink of `format` keeps for `terminal`'s frame, and the
/// frame's size; None when the terminal is not a picture.
fn sink_bytes(graph: &Graph, terminal: &str, sources: &HashMap<String, SourceImage>, format: SinkFormat) -> Result<Option<(usize, usize, usize)>, IoError> {
    let (w, h, c) = match banded::output_size(graph, terminal, sources) {
        Ok(d) => d,
        Err(EngineError::Band(_)) => return Ok(None),
        Err(e) => return Err(engine_error(e)),
    };
    if c != 4 {
        return Ok(None);
    }
    Ok(Some((w, h, memory::bytes(w, h, format.bytes_per_pixel(), 1)?)))
}

/// The tallest band whose banded render of `terminal`, beside a sink of
/// `format` for its whole frame, fits `ceiling` bytes; None when no band
/// fits or the bands cannot follow the graph.
pub fn sink_band_rows(
    graph: &Graph,
    terminal: &str,
    sources: &HashMap<String, SourceImage>,
    ceiling: usize,
    format: SinkFormat,
) -> Result<Option<usize>, IoError> {
    let Some((_, _, kept)) = sink_bytes(graph, terminal, sources, format)? else { return Ok(None) };
    match banded::band_rows_for(graph, &[terminal], sources, ceiling, kept) {
        Ok(rows) => Ok(rows),
        Err(EngineError::Band(_)) => Ok(None),
        Err(e) => Err(engine_error(e)),
    }
}

/// `terminal`'s frame rendered band by band, `band_rows` rows at a time,
/// each band handed straight to a sink of `format`: the whole frame is
/// never held as f32, only as the samples its encoder takes. The sink's
/// file is the whole-frame render's encode, byte for byte. None when the
/// bands cannot follow the graph (render it whole) or the terminal is
/// not a picture.
pub fn render_into_sink(
    graph: &Graph,
    terminal: &str,
    sources: &HashMap<String, SourceImage>,
    band_rows: usize,
    format: SinkFormat,
) -> Result<Option<(BandSink, BandedReport)>, IoError> {
    let Some((w, h, kept)) = sink_bytes(graph, terminal, sources, format)? else { return Ok(None) };
    let _job = memory::Job::admit(kept, "export samples")?;
    let mut sink = BandSink::new(format, w, h)?;
    let mut failed: Option<IoError> = None;
    let rendered = banded::render_banded(graph, &[terminal], sources, band_rows, &mut |_, y0, v| match v {
        Value::Image(band) => sink.put(y0, &band).map_err(|e| {
            failed = Some(e);
            EngineError::Cancelled
        }),
        Value::Mask(_) => Err(EngineError::TypeMismatch { node: terminal.to_string(), port: "out".into() }),
    });
    if let Some(e) = failed {
        return Err(e);
    }
    match rendered {
        Ok(report) => Ok(Some((sink, report))),
        Err(EngineError::Band(_)) => Ok(None),
        Err(e) => Err(engine_error(e)),
    }
}

/// An export within `ceiling` bytes, for a caller with no whole-frame
/// steps of its own after the render (the iOS port): the tallest band
/// that fits, rendered into the sink and encoded. The file and the
/// frame's size; None when no band fits or the bands cannot follow the
/// graph, which the caller answers by rendering whole or exporting
/// smaller (heeler_engine::banded::largest_export_edge).
pub fn export_in_bands(
    graph: &Graph,
    terminal: &str,
    sources: &HashMap<String, SourceImage>,
    ceiling: usize,
    encoding: Encoding<'_>,
) -> Result<Option<(Vec<u8>, usize, usize)>, IoError> {
    let format = encoding.format();
    let Some((w, h, kept)) = sink_bytes(graph, terminal, sources, format)? else { return Ok(None) };
    let encoding_peak = memory::sum([
        banded::source_bytes(graph, &[terminal], sources).map_err(engine_error)?,
        format.encoding_bytes(w, h)?,
    ])?;
    if encoding_peak > ceiling {
        return Ok(None);
    }
    let Some(rows) = sink_band_rows(graph, terminal, sources, ceiling, format)? else { return Ok(None) };
    let render_peak = memory::sum([
        banded::estimate_banded(graph, &[terminal], sources, rows).map_err(engine_error)?, kept,
    ])?;
    let job = memory::Job::admit(render_peak.max(encoding_peak), "banded export and encoding")?;
    // A nested encoder admission may not grow beyond the caller's ceiling.
    job.worker(ceiling).run(|| {
        let Some((sink, _)) = render_into_sink(graph, terminal, sources, rows, format)? else { return Ok(None) };
        Ok(Some((sink.encode(encoding)?, w, h)))
    })
}

/// export_in_bands with the photographs in `rows` making their rows on
/// demand from what their decoders kept (heeler_io::decode_rows_with,
/// or a caller's own codec through heic::KeptRgba8), never decoded
/// whole: their entries in `sources` may be left out. None as
/// export_in_bands answers; the caller then decodes them whole.
pub fn export_in_bands_from(
    graph: &Graph,
    terminal: &str,
    sources: &HashMap<String, SourceImage>,
    rows: banded::RowSources,
    ceiling: usize,
    encoding: Encoding<'_>,
) -> Result<Option<(Vec<u8>, usize, usize)>, IoError> {
    banded::with_row_sources(rows, || export_in_bands(graph, terminal, sources, ceiling, encoding))
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

    /// A graph rendered straight into the sink, band by band, writes the
    /// whole-frame render's file byte for byte in every format, at band
    /// heights that divide the frame and that do not; within a ceiling,
    /// export_in_bands picks its band and writes the same file.
    #[test]
    fn a_graph_rendered_into_the_sink_writes_the_whole_renders_file() {
        use heeler_graph::{ParamValue, Registry, Section};
        let registry = Registry::builtin();
        let mut g = Graph::new("stream");
        for (ty, id) in [("heeler.image_source", "src"), ("heeler.exposure", "exp"), ("heeler.blur", "blur"), ("heeler.grain", "grain")] {
            g.add_node(registry.instantiate(ty, id, Section::Creative).unwrap()).unwrap();
        }
        g.set_param("exp", "exposure", ParamValue::Number(0.6)).unwrap();
        g.set_param("blur", "radius", ParamValue::Number(3.0)).unwrap();
        g.set_param("grain", "intensity", ParamValue::Number(40.0)).unwrap();
        g.connect("src", "out", "exp", "in").unwrap();
        g.connect("exp", "out", "blur", "in").unwrap();
        g.connect("blur", "out", "grain", "in").unwrap();
        for opaque in [true, false] {
            let sources = HashMap::from([("src".to_string(), SourceImage { image: std::sync::Arc::new(frame(61, 43, opaque)), version: 1, measured: false })]);
            let whole = match heeler_engine::Executor::new().render(&g, "grain", &sources).unwrap() {
                Value::Image(i) => i,
                Value::Mask(_) => unreachable!(),
            };
            let cases: [(Encoding<'_>, Vec<u8>); 6] = [
                (Encoding::Jpeg(88), crate::encode_jpeg(&whole, 88).unwrap()),
                (Encoding::Png8, crate::encode_png(&whole).unwrap()),
                (Encoding::Png16, crate::encode_png16(&whole).unwrap()),
                (Encoding::Webp(80), crate::encode_webp(&whole, 80).unwrap()),
                (Encoding::Tiff16(Default::default()), crate::encode_tiff16_export(&whole, Default::default()).unwrap()),
                (Encoding::Dng { exif: None, xmp: None }, crate::encode_dng_with_xmp(&whole, None, None).unwrap()),
            ];
            for (encoding, want) in cases {
                for rows in [7, 43] {
                    let (sink, report) = render_into_sink(&g, "grain", &sources, rows, encoding.format()).unwrap().unwrap();
                    assert!(report.whole.is_empty(), "{report:?}");
                    assert_eq!(sink.encode(encoding).unwrap(), want, "{:?} in bands of {rows}, opaque {opaque}", encoding.format());
                }
                let (bytes, w, h) = export_in_bands(&g, "grain", &sources, 1 << 30, encoding).unwrap().unwrap();
                assert_eq!((bytes, w, h), (want, 61, 43), "{:?} within a ceiling", encoding.format());
            }
        }
    }
}

#[cfg(test)]
mod ceiling_tests {
    use super::*;
    use heeler_graph::{Registry, Section};
    use std::sync::Arc;

    #[test]
    fn an_export_ceiling_covers_encoding_as_well_as_rendering() {
        let (w, h) = (512, 128);
        let mut image = ImageBuf::new(w, h);
        for (i, px) in image.data.chunks_exact_mut(4).enumerate() {
            let mut n = (i as u32).wrapping_mul(0x9e3779b1);
            n ^= n >> 15;
            px.copy_from_slice(&[(n & 255) as f32 / 255.0, ((n >> 8) & 255) as f32 / 255.0, ((n >> 16) & 255) as f32 / 255.0, 1.0]);
        }
        let mut graph = Graph::new("encoding ceiling");
        graph.add_node(Registry::builtin().instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
        let sources = HashMap::from([("src".to_string(), SourceImage { image: Arc::new(image), version: 1, measured: false })]);
        let source = w * h * 16;
        for encoding in [Encoding::Jpeg(90), Encoding::Png8, Encoding::Png16, Encoding::Webp(80), Encoding::Tiff16(Default::default()), Encoding::Dng { exif: None, xmp: None }] {
            let format = encoding.format();
            let render_only = banded::estimate_banded(&graph, &["src"], &sources, 1).unwrap() + w * h * format.bytes_per_pixel();
            assert!(sink_band_rows(&graph, "src", &sources, render_only, format).unwrap().is_some());
            assert!(export_in_bands(&graph, "src", &sources, render_only, encoding).unwrap().is_none(), "{format:?} must also fit its encoder");
            let ceiling = source + format.encoding_bytes(w, h).unwrap();
            let want = export_in_bands(&graph, "src", &sources, 1 << 30, encoding).unwrap().unwrap().0;
            memory::with_budget(ceiling, || {
                let got = export_in_bands(&graph, "src", &sources, ceiling, encoding).unwrap().unwrap();
                assert_eq!(got.0, want, "{format:?} at its encoding ceiling");
                assert!(memory::budget().snapshot().peak <= ceiling);
            });
        }
    }

    #[test]
    fn a_sink_encoder_admits_its_workspace_before_encoding() {
        let mut sink = BandSink::new(SinkFormat::Png8, 128, 128).unwrap();
        sink.put(0, &ImageBuf::new(128, 128)).unwrap();
        memory::with_budget(128 * 128 * 4, || {
            assert!(matches!(sink.png8(), Err(IoError::Memory(_))));
        });
    }
}
