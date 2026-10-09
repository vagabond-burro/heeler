//! The 1:1 quality probe (2026-09-29, with two reference RAW editors and
//! Heeler side by side at 100 percent on the same RW2: "There is a clear
//! gap in image quality in Heeler"). Renders one RAW through the paths
//! the app uses at default settings for a new photograph: the 1:1 slice
//! the viewer asks for, the full-resolution settle and the full-size
//! export, and writes 100 percent crops plus detail numbers.
//!
//! Ignored, and a no-op without the file:
//!   HEELER_QUALITY_RAW=<path to a RAW> HEELER_QUALITY_OUT=<dir>
//!   HEELER_QUALITY_CROP=x,y,w,h (pixels of the upright frame)
//!   HEELER_QUALITY_REFS=<tiff>@x:y,... (independent developments, with
//!     where the crop sits in each; registered from there)
//!   HEELER_QUALITY_TAG=<name> (file prefix), HEELER_QUALITY_OVERVIEW=1
//!   HEELER_QUALITY_SHARPEN=<0..100> (capture sharpening; 0 is the old
//!     develop), HEELER_QUALITY_DEMOSAIC=<LibRaw user_qual>,
//!     HEELER_QUALITY_CS=<gain>,<radius> (extra sharpening, for tuning)
//!   cargo test -p heeler-desktop --lib quality_probe -- --ignored --nocapture
use super::*;
use std::path::{Path, PathBuf};

/// The fresh graph a never-edited RAW opens with, exactly as the
/// frontend serializes it (serializeFreshGraph over NEUTRAL_NODES).
pub(crate) const FRESH_GRAPH: &str = r#"{"schema_version":1,"graph_id":"probe_ui","nodes":[{"id":"src","type":"heeler.image_source","label":"Image Source","enabled":true,"params":{"camera_wb":1,"camera_matrix":1},"x":24,"y":24},{"id":"stdcolor","type":"heeler.standard_color","label":"Standard Color","enabled":true,"params":{"temperature":6500,"tint":0,"saturation":0,"vibrance":0,"texture":0,"clarity":0,"dehaze":0,"texture_shadows":100,"texture_midtones":100,"texture_highlights":100,"texture_red":100,"texture_green":100,"texture_blue":100,"clarity_shadows":100,"clarity_midtones":100,"clarity_highlights":100,"clarity_red":100,"clarity_green":100,"clarity_blue":100,"dehaze_shadows":100,"dehaze_midtones":100,"dehaze_highlights":100,"dehaze_red":100,"dehaze_green":100,"dehaze_blue":100},"x":224,"y":24},{"id":"exposure","type":"heeler.exposure","label":"Exposure","enabled":true,"params":{"exposure":0,"contrast":0,"color_contrast":0,"highlights":0,"shadows":0,"whites":0,"blacks":0},"x":424,"y":24},{"id":"output","type":"heeler.output","label":"Output","enabled":true,"params":{},"x":824,"y":24},{"id":"profile","type":"heeler.tone_profile","label":"Tone Profile","enabled":true,"params":{"contrast":100,"colorfulness":0,"development":0,"baseline_ev":1.3,"shadow_toe":50,"highlight_rolloff":25,"mode":"standard","film":""},"x":624,"y":24}],"connections":[{"from":["stdcolor","out"],"to":["exposure","in"]},{"from":["profile","out"],"to":["output","in"]},{"from":["exposure","out"],"to":["profile","in"]},{"from":["src","out"],"to":["stdcolor","in"]}]}"#;

fn srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

/// A display-referred crop: sRGB-encoded RGB in 0..1, what the screen gets.
pub(crate) struct Crop {
    pub w: usize,
    pub h: usize,
    pub rgb: Vec<[f32; 3]>,
}

impl Crop {
    pub fn of(img: &ImageBuf, x: usize, y: usize, w: usize, h: usize) -> Crop {
        let mut rgb = Vec::with_capacity(w * h);
        for yy in y..y + h {
            for xx in x..x + w {
                let p = img.pixel(xx.min(img.width - 1), yy.min(img.height - 1));
                rgb.push([srgb(p[0]), srgb(p[1]), srgb(p[2])]);
            }
        }
        Crop { w, h, rgb }
    }
    pub fn luma(&self) -> Vec<f32> {
        self.rgb.iter().map(|p| 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).collect()
    }
    pub fn save_png(&self, path: &Path) {
        let mut img = ImageBuf::new(self.w, self.h);
        for (i, p) in self.rgb.iter().enumerate() {
            img.data[i * 4..i * 4 + 4].copy_from_slice(&[p[0], p[1], p[2], 1.0]);
        }
        std::fs::write(path, heeler_io::encode_png_raw(&img).unwrap()).unwrap();
    }
}

fn box_blur(plane: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (a, b) = (x.saturating_sub(r), (x + r).min(w - 1));
            let s: f32 = plane[y * w + a..=y * w + b].iter().sum();
            tmp[y * w + x] = s / (b - a + 1) as f32;
        }
    }
    let mut out = vec![0.0f32; w * h];
    for y in 0..h {
        let (a, b) = (y.saturating_sub(r), (y + r).min(h - 1));
        for x in 0..w {
            let mut s = 0.0;
            for yy in a..=b {
                s += tmp[yy * w + x];
            }
            out[y * w + x] = s / (b - a + 1) as f32;
        }
    }
    out
}

/// Detail numbers for a display-referred crop.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Detail {
    /// RMS of the finest band (luma minus its 3x3 box mean), in 8-bit levels.
    pub fine: f32,
    /// RMS of a coarse band (5x5 box minus 21x21 box), in 8-bit levels.
    pub coarse: f32,
    /// fine / coarse: tone-curve-independent acutance.
    pub acutance: f32,
    /// Mean absolute neighbor difference of luma, in 8-bit levels.
    pub gradient: f32,
    /// RMS of the fine band of the chroma planes (false color), levels.
    pub chroma_fine: f32,
}

pub(crate) fn detail(c: &Crop) -> Detail {
    let (w, h) = (c.w, c.h);
    let l = c.luma();
    let b1 = box_blur(&l, w, h, 1);
    let b2 = box_blur(&l, w, h, 2);
    let b10 = box_blur(&l, w, h, 10);
    let rms = |f: &dyn Fn(usize) -> f32| {
        let mut s = 0.0f64;
        let mut n = 0usize;
        for y in 12..h.saturating_sub(12) {
            for x in 12..w.saturating_sub(12) {
                let v = f(y * w + x) as f64;
                s += v * v;
                n += 1;
            }
        }
        ((s / n.max(1) as f64).sqrt() * 255.0) as f32
    };
    let fine = rms(&|i| l[i] - b1[i]);
    let coarse = rms(&|i| b2[i] - b10[i]);
    let mut g = 0.0f64;
    let mut n = 0usize;
    for y in 0..h - 1 {
        for x in 0..w - 1 {
            let i = y * w + x;
            g += ((l[i] - l[i + 1]).abs() + (l[i] - l[i + w]).abs()) as f64;
            n += 2;
        }
    }
    let cb: Vec<f32> = c.rgb.iter().zip(&l).map(|(p, y)| p[2] - y).collect();
    let cr: Vec<f32> = c.rgb.iter().zip(&l).map(|(p, y)| p[0] - y).collect();
    let cbb = box_blur(&cb, w, h, 1);
    let crb = box_blur(&cr, w, h, 1);
    let chroma_fine = (rms(&|i| cb[i] - cbb[i]).powi(2) + rms(&|i| cr[i] - crb[i]).powi(2)).sqrt();
    Detail { fine, coarse, acutance: fine / coarse.max(1e-6), gradient: (g / n.max(1) as f64 * 255.0) as f32, chroma_fine }
}

/// Integer offset of `b` against `a` (the position in `b` of a's
/// top-left), by gradient correlation: coarse at 1/8, then exact.
pub(crate) fn register(a: &ImageBuf, ax: usize, ay: usize, w: usize, h: usize, b: &ImageBuf, guess: (i64, i64), reach: i64) -> (i64, i64) {
    let lum = |img: &ImageBuf, x: i64, y: i64| -> f32 {
        let x = x.clamp(0, img.width as i64 - 1) as usize;
        let y = y.clamp(0, img.height as i64 - 1) as usize;
        let p = img.pixel(x, y);
        srgb(0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2])
    };
    let score = |dx: i64, dy: i64, step: i64| -> f64 {
        // Normalized correlation of horizontal+vertical gradients.
        let (mut sab, mut saa, mut sbb) = (0.0f64, 0.0f64, 0.0f64);
        let mut y = 0;
        while y < h as i64 - step {
            let mut x = 0;
            while x < w as i64 - step {
                let (px, py) = (ax as i64 + x, ay as i64 + y);
                let ga = (lum(a, px + step, py) - lum(a, px, py)) + (lum(a, px, py + step) - lum(a, px, py));
                let (qx, qy) = (px + dx, py + dy);
                let gb = (lum(b, qx + step, qy) - lum(b, qx, qy)) + (lum(b, qx, qy + step) - lum(b, qx, qy));
                sab += (ga * gb) as f64;
                saa += (ga * ga) as f64;
                sbb += (gb * gb) as f64;
                x += step;
            }
            y += step;
        }
        sab / (saa * sbb).sqrt().max(1e-12)
    };
    let mut best = (guess, f64::MIN);
    let mut d = -reach;
    while d <= reach {
        let mut e = -reach;
        while e <= reach {
            let s = score(guess.0 + d, guess.1 + e, 16);
            if s > best.1 {
                best = ((guess.0 + d, guess.1 + e), s);
            }
            e += 8;
        }
        d += 8;
    }
    let c = best.0;
    let mut fine = (c, f64::MIN);
    for d in -10..=10 {
        for e in -10..=10 {
            let s = score(c.0 + d, c.1 + e, 2);
            if s > fine.1 {
                fine = ((c.0 + d, c.1 + e), s);
            }
        }
    }
    eprintln!("  registered at {:?} (corr {:.3})", fine.0, fine.1);
    fine.0
}

fn env_crop() -> (usize, usize, usize, usize) {
    let v: Vec<usize> = std::env::var("HEELER_QUALITY_CROP")
        .unwrap_or_else(|_| "1500,2600,800,600".into())
        .split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();
    (v[0], v[1], v[2], v[3])
}

/// A [0.5, 0.5] average on both axes: bilinear sampling half a pixel off.
fn shift_half(c: &Crop) -> Crop {
    let mut rgb = c.rgb.clone();
    for y in 0..c.h - 1 {
        for x in 0..c.w - 1 {
            let i = y * c.w + x;
            for k in 0..3 {
                rgb[i][k] = 0.25 * (c.rgb[i][k] + c.rgb[i + 1][k] + c.rgb[i + c.w][k] + c.rgb[i + c.w + 1][k]);
            }
        }
    }
    Crop { w: c.w, h: c.h, rgb }
}

fn jpeg_trip(img: &ImageBuf, q: u8) -> ImageBuf {
    heeler_io::decode_bytes(&heeler_io::encode_jpeg(img, q).unwrap()).unwrap()
}

fn report(name: &str, c: &Crop) -> Detail {
    let d = detail(c);
    eprintln!(
        "{name:<28} fine {:6.2}  coarse {:6.2}  acutance {:5.3}  gradient {:6.2}  chroma_fine {:5.2}",
        d.fine, d.coarse, d.acutance, d.gradient, d.chroma_fine
    );
    d
}

/// The three real paths over one RAW at the fresh graph's defaults.
#[test]
#[ignore]
fn quality_probe_one_to_one() {
    let Some(raw) = std::env::var_os("HEELER_QUALITY_RAW").map(PathBuf::from).filter(|p| p.is_file()) else {
        eprintln!("HEELER_QUALITY_RAW not set or missing: skipped");
        return;
    };
    let out = PathBuf::from(std::env::var("HEELER_QUALITY_OUT").unwrap_or_else(|_| "/tmp/heeler-quality".into()));
    std::fs::create_dir_all(&out).unwrap();
    let tag = std::env::var("HEELER_QUALITY_TAG").unwrap_or_else(|_| "now".into());
    let ui: UiGraph = serde_json::from_str(FRESH_GRAPH).unwrap();
    let mut opts = source_opts_of(&ui);
    if let Some(q) = std::env::var("HEELER_QUALITY_DEMOSAIC").ok().and_then(|v| v.parse().ok()) {
        opts.demosaic = q;
        eprintln!("demosaic override: user_qual {q}");
    }
    if let Some(v) = std::env::var("HEELER_QUALITY_SHARPEN").ok().and_then(|v| v.parse().ok()) {
        opts.capture_sharpen = v;
    }
    eprintln!("capture sharpening {}", opts.capture_sharpen);

    let t = std::time::Instant::now();
    let mut decoded = heeler_io::decode_any_with(&raw, opts).unwrap();
    let decode_ms = t.elapsed().as_millis();
    if let Ok(v) = std::env::var("HEELER_QUALITY_CS") {
        let v: Vec<f32> = v.split(',').filter_map(|s| s.parse().ok()).collect();
        let t = std::time::Instant::now();
        heeler_engine::capture_sharpen(&mut decoded, v[0], v[1]);
        eprintln!("extra capture sharpen {v:?} in {} ms", t.elapsed().as_millis());
    }
    let source = Arc::new(decoded);
    eprintln!("decode {}x{} in {decode_ms} ms", source.width, source.height);
    let (cx, cy, cw, ch) = env_crop();

    if std::env::var_os("HEELER_QUALITY_OVERVIEW").is_some() {
        let small = downscale(&source, 1500);
        std::fs::write(out.join("overview_source.png"), heeler_io::encode_png(&small).unwrap()).unwrap();
    }

    // (c) The export: render_export at full size.
    let t = std::time::Instant::now();
    let export = render_export(&ui, source.clone(), &HashMap::new()).unwrap();
    let export_ms = t.elapsed().as_millis();
    eprintln!("export render {}x{} in {export_ms} ms", export.width, export.height);
    if std::env::var_os("HEELER_QUALITY_OVERVIEW").is_some() {
        let small = downscale(&export, 1500);
        std::fs::write(out.join("overview_export.png"), heeler_io::encode_png(&small).unwrap()).unwrap();
    }

    // The reduced preview (Fit) against the export shrunk to its size:
    // the preview must show what the render will.
    {
        let t = std::time::Instant::now();
        let pre = heeler_io::decode_preview_at(&raw, opts, 2048).unwrap();
        let pre = Arc::new(downscale(&pre, 2048));
        let pre_decode = t.elapsed().as_millis();
        let rendered = render_export(&ui, pre.clone(), &HashMap::new()).unwrap();
        let shrunk = downscale(&export, rendered.width.max(rendered.height));
        let k = rendered.width as f64 / export.width as f64;
        let (x, y, w, h) = ((cx as f64 * k) as usize, (cy as f64 * k) as usize, (cw as f64 * k) as usize, (ch as f64 * k) as usize);
        eprintln!("preview@2048 decode {pre_decode} ms, {}x{}", rendered.width, rendered.height);
        report("preview@2048", &Crop::of(&rendered, x, y, w, h));
        report("export shrunk to 2048", &Crop::of(&shrunk, x, y, w, h));
    }

    // (b) The settle: the whole frame at full resolution, as the viewer
    // receives it (JPEG at the settle's default quality).
    let settle = jpeg_trip(&export, preview_jpeg_quality(true, None));

    // (a) The 1:1 slice: the viewer's rect (the crop plus the viewer's
    // margin), injected the way render_preview_attempt injects it,
    // rendered on a fresh full-tier executor, sent as a q94 JPEG.
    let (fw, fh) = (source.width as f64, source.height as f64);
    let m = 64.0;
    let rect = [
        ((cx as f64 - m) / fw).max(0.0),
        ((cy as f64 - m) / fh).max(0.0),
        ((cw as f64 + 2.0 * m) / fw).min(1.0),
        ((ch as f64 + 2.0 * m) / fh).min(1.0),
    ];
    let t = std::time::Instant::now();
    let (sliced, actual) = inject_roi_for_view(&ui, rect, (source.width, source.height), None).expect("slice injection");
    let registry = Registry::builtin();
    let g = build_graph(&sliced, &registry).unwrap();
    let mut sources = HashMap::new();
    for n in sliced.nodes.iter().filter(|n| n.node_type == "heeler.image_source") {
        sources.insert(n.id.clone(), SourceImage { image: source.clone(), version: 1, measured: false });
    }
    let mut exec = full_tier_executor(None);
    let patch = exec.render(&g, &terminal_of(&sliced).unwrap(), &sources).unwrap();
    let patch = (**patch.as_image().unwrap()).clone();
    let slice_ms = t.elapsed().as_millis();
    let px = (actual[0] * fw).round() as usize;
    let py = (actual[1] * fh).round() as usize;
    eprintln!("1:1 slice {}x{} at ({px},{py}) in {slice_ms} ms", patch.width, patch.height);
    let slice_jpeg = jpeg_trip(&patch, preview_jpeg_quality(false, None));

    let c_export = Crop::of(&export, cx, cy, cw, ch);
    let c_settle = Crop::of(&settle, cx, cy, cw, ch);
    let c_slice = Crop::of(&slice_jpeg, cx - px, cy - py, cw, ch);
    let c_slice_exact = Crop::of(&patch, cx - px, cy - py, cw, ch);
    c_export.save_png(&out.join(format!("{tag}_export.png")));
    c_settle.save_png(&out.join(format!("{tag}_settle.png")));
    c_slice.save_png(&out.join(format!("{tag}_slice.png")));
    let mut sheet: Vec<(String, Crop)> = Vec::new();
    let d_export = report("export", &c_export);
    report("settle (JPEG)", &c_settle);
    report("1:1 slice (JPEG q94)", &c_slice);
    let d_slice = report("1:1 slice (engine pixels)", &c_slice_exact);
    // What the compositor does to that slice when the stage sits a
    // fraction of a device pixel off the grid (measured in Chromium, the
    // engine of WebView2: a half-pixel translate is a bilinear resample,
    // a [0.5, 0.5] average on both axes).
    report("slice, half-pixel offset", &shift_half(&c_slice));
    // The preview must match the render: the slice's own pixels against
    // the export's, before either is encoded.
    let diff: f32 = c_slice_exact.rgb.iter().zip(&c_export.rgb).map(|(a, b)| (0..3).map(|k| (a[k] - b[k]).abs()).fold(0.0, f32::max)).fold(0.0, f32::max);
    eprintln!("slice vs export max abs difference: {:.2} levels", diff * 255.0);
    let _ = (d_export, d_slice);
    sheet.push((format!("{tag} slice"), c_slice));

    // Independent developments of the same file, registered to the crop.
    if let Ok(refs) = std::env::var("HEELER_QUALITY_REFS") {
        for r in refs.split(',').filter(|s| !s.is_empty()) {
            let (path, guess) = match r.split_once('@') {
                Some((p, g)) => {
                    let v: Vec<i64> = g.split(':').filter_map(|s| s.parse().ok()).collect();
                    (p.to_string(), (v[0], v[1]))
                }
                None => (r.to_string(), (cx as i64, cy as i64)),
            };
            let img = heeler_io::decode_any(Path::new(&path)).unwrap();
            eprintln!("reference {path}: {}x{}", img.width, img.height);
            let (rx, ry) = register(&export, cx, cy, cw, ch, &img, (guess.0 - cx as i64, guess.1 - cy as i64), 160);
            let (rx, ry) = ((cx as i64 + rx).max(0) as usize, (cy as i64 + ry).max(0) as usize);
            let c = Crop::of(&img, rx, ry, cw, ch);
            let name = Path::new(&path).file_stem().unwrap().to_string_lossy().to_string();
            c.save_png(&out.join(format!("ref_{name}.png")));
            report(&format!("ref {name}"), &c);
            sheet.push((name, c));
        }
    }
    write_sheet(&sheet, &out.join(format!("{tag}_sheet.png")));
}

/// The crops side by side, the central 320 by 240 of each at 2x
/// nearest neighbor, so single pixels are visible.
fn write_sheet(crops: &[(String, Crop)], path: &Path) {
    let (zw, zh, k) = (320usize, 240usize, 2usize);
    let mut img = ImageBuf::new(zw * k * crops.len() + 8 * crops.len(), zh * k);
    for (i, (_, c)) in crops.iter().enumerate() {
        let (ox, oy) = ((c.w - zw) / 2, (c.h - zh) / 2);
        for y in 0..zh * k {
            for x in 0..zw * k {
                let p = c.rgb[(oy + y / k) * c.w + ox + x / k];
                let lin = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
                let dx = i * (zw * k + 8) + x;
                let o = (y * img.width + dx) * 4;
                img.data[o..o + 4].copy_from_slice(&[lin(p[0]), lin(p[1]), lin(p[2]), 1.0]);
            }
        }
    }
    std::fs::write(path, heeler_io::encode_png(&img).unwrap()).unwrap();
}

/// The Source section's Sharpening reaches the develop, Standard when
/// the graph says nothing (every photograph saved before it existed),
/// and a different choice is a different decode in every cache.
#[test]
fn the_source_sharpening_choice_reaches_the_develop() {
    let fresh: UiGraph = serde_json::from_str(FRESH_GRAPH).unwrap();
    assert_eq!(source_opts_of(&fresh).capture_sharpen, heeler_io::DEFAULT_CAPTURE_SHARPEN);
    let with = |choice: &str| {
        let mut ui: UiGraph = serde_json::from_str(FRESH_GRAPH).unwrap();
        let src = ui.nodes.iter_mut().find(|n| n.node_type == "heeler.image_source").unwrap();
        src.params.insert("sharpening".into(), serde_json::json!(choice));
        source_opts_of(&ui)
    };
    assert_eq!(with("off").capture_sharpen, 0);
    assert_eq!(with("low").capture_sharpen, 30);
    assert_eq!(with("standard").capture_sharpen, heeler_io::DEFAULT_CAPTURE_SHARPEN);
    assert_eq!(with("high").capture_sharpen, 100);
    assert_ne!(source_cache_key("img", with("off")), source_cache_key("img", with("standard")));
    // The registry declares the same choice and default the decoder
    // resolves, so the graph inspector and Develop draw the same row.
    let registry = Registry::builtin();
    let src = registry.get("heeler.image_source").expect("image source spec");
    let p = src.params.iter().find(|p| p.name == "sharpening").expect("sharpening param");
    assert_eq!(p.default, ParamValue::Text("standard".into()));
    assert_eq!(p.choices, vec!["off", "low", "standard", "high"]);
}
