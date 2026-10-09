//! The phone DNG check, in numbers: a develop rendered by the file's
//! own instructions (src/dng_gain.rs) beside the preview the phone
//! embedded, which is the picture those instructions describe.
//!
//!     cargo run -p heeler-io --features libraw --example gainprobe -- <files...>
//!
//! Both pictures are reduced to a 32 by 24 grid of cell means and
//! compared in display values (0 to 255), cell against cell:
//!
//! - bias: the mean signed difference, ours minus the preview's. An
//!   exposure error shows here.
//! - spread: the mean absolute difference once the bias is known. A
//!   tone or local-contrast error shows here.
//!
//! "as developed" is the frame before this module touches it, lifted by
//! the default profile's 1.3 stops, which is what the app showed until
//! 26.4.1. "rendered" is the file's instructions followed, "per channel"
//! the same with the curve on each channel alone (the comparison behind
//! the hue-held curve), and "its color" compares colorfulness, the
//! spread between the greatest and least channel, which luma cannot see.
//! These are the numbers the choice of color space in `dng_gain::render`
//! rests on.

use std::path::Path;

use heeler_engine::ops::to_display;
use heeler_engine::ImageBuf;
use heeler_io::{apply_orientation, decode_bytes, dng_gain, extract_raw_preview, raw_orientation};

const ACROSS: usize = 32;
const DOWN: usize = 24;

/// Cell means of the picture's luma, in display values.
fn cells(img: &ImageBuf, gain: f32) -> Vec<f32> {
    let mut sum = vec![0f64; ACROSS * DOWN];
    let mut n = vec![0u32; ACROSS * DOWN];
    for y in 0..img.height {
        let cy = y * DOWN / img.height;
        for x in 0..img.width {
            let cx = x * ACROSS / img.width;
            let o = (y * img.width + x) * 4;
            let d = &img.data[o..o + 3];
            let luma = 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
            sum[cy * ACROSS + cx] += to_display((luma * gain).clamp(0.0, 1.0)) as f64 * 255.0;
            n[cy * ACROSS + cx] += 1;
        }
    }
    sum.iter().zip(&n).map(|(s, n)| (*s / (*n).max(1) as f64) as f32).collect()
}

/// Cell means of the picture's colorfulness: the spread between the
/// greatest and least channel, in display values. Luma alone cannot
/// see a saturated sky rendered too deep or too pale.
fn chroma_cells(img: &ImageBuf) -> Vec<f32> {
    let mut sum = vec![0f64; ACROSS * DOWN];
    let mut n = vec![0u32; ACROSS * DOWN];
    for y in 0..img.height {
        let cy = y * DOWN / img.height;
        for x in 0..img.width {
            let cx = x * ACROSS / img.width;
            let o = (y * img.width + x) * 4;
            let d: Vec<f32> = img.data[o..o + 3].iter().map(|v| to_display(v.clamp(0.0, 1.0)) * 255.0).collect();
            let spread = d[0].max(d[1]).max(d[2]) - d[0].min(d[1]).min(d[2]);
            sum[cy * ACROSS + cx] += spread as f64;
            n[cy * ACROSS + cx] += 1;
        }
    }
    sum.iter().zip(&n).map(|(s, n)| (*s / (*n).max(1) as f64) as f32).collect()
}

fn compare(label: &str, ours: &[f32], theirs: &[f32]) {
    let n = ours.len() as f32;
    let bias = ours.iter().zip(theirs).map(|(a, b)| a - b).sum::<f32>() / n;
    let spread = ours.iter().zip(theirs).map(|(a, b)| (a - b - bias).abs()).sum::<f32>() / n;
    let worst = ours.iter().zip(theirs).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
    println!("  {label:<14} bias {bias:+7.1}  spread {spread:5.1}  worst cell {worst:5.1}");
}

/// The two pictures reduced to 900 pixels wide each and set side by
/// side, as a JPEG.
fn side_by_side(ours: &ImageBuf, theirs: &ImageBuf) -> Result<Vec<u8>, String> {
    let w = 900usize;
    let h = (w * ours.height / ours.width.max(1)).max(1);
    let mut pair = ImageBuf::new(w * 2, h);
    for (slot, src) in [ours, theirs].into_iter().enumerate() {
        for y in 0..h {
            for x in 0..w {
                let sx = (x * src.width / w).min(src.width - 1);
                let sy = (y * src.height / h).min(src.height - 1);
                pair.set_pixel(slot * w + x, y, src.pixel(sx, sy));
            }
        }
    }
    heeler_io::encode_jpeg(&pair, 88).map_err(|e| e.to_string())
}

/// The default Tone Profile a RAW opens with (PROFILE_DEFAULTS in
/// state.ts), through the engine's own op.
fn profiled(img: &ImageBuf) -> ImageBuf {
    use heeler_graph::{Node, ParamValue, Section};
    let mut params = std::collections::BTreeMap::new();
    params.insert("contrast".into(), ParamValue::Number(100.0));
    params.insert("baseline_ev".into(), ParamValue::Number(1.3));
    params.insert("shadow_toe".into(), ParamValue::Number(50.0));
    params.insert("highlight_rolloff".into(), ParamValue::Number(25.0));
    let node = Node {
        id: "tone".into(),
        node_type: "heeler.tone_profile".into(),
        version: 1,
        label: "Tone Profile".into(),
        section: Section::RawFoundation,
        enabled: true,
        params,
        inputs: Vec::new(),
        outputs: Vec::new(),
    };
    let inputs = [("in".to_string(), heeler_engine::Value::Image(std::sync::Arc::new(img.clone())))];
    heeler_engine::ops::execute(&node, &inputs)
        .ok()
        .and_then(|v| v.as_image().map(|i| (**i).clone()))
        .unwrap_or_else(|| img.clone())
}

/// Median over the grid's cells of the mean linear luma.
fn median_light(img: &ImageBuf) -> f32 {
    let mut sum = vec![0f64; ACROSS * DOWN];
    let mut n = vec![0u32; ACROSS * DOWN];
    for y in 0..img.height {
        let cy = y * DOWN / img.height;
        for x in 0..img.width {
            let cx = x * ACROSS / img.width;
            let o = (y * img.width + x) * 4;
            let d = &img.data[o..o + 3];
            sum[cy * ACROSS + cx] += (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]).max(0.0) as f64;
            n[cy * ACROSS + cx] += 1;
        }
    }
    let mut means: Vec<f32> = sum.iter().zip(&n).map(|(s, n)| (*s / (*n).max(1) as f64) as f32).collect();
    means.sort_by(|a, b| a.total_cmp(b));
    means[means.len() / 2]
}

/// How many stops `ours` sits over (+) or under (-) `theirs`.
fn stops(ours: &ImageBuf, theirs: &ImageBuf) -> f32 {
    (median_light(ours).max(1e-6) / median_light(theirs).max(1e-6)).log2()
}

fn probe(path: &Path) {
    println!("== {} ==", path.file_name().unwrap_or_default().to_string_lossy());
    let Ok(bytes) = std::fs::read(path) else {
        println!("  unreadable\n");
        return;
    };
    let Some(rendering) = dng_gain::file_rendering(&bytes) else {
        println!("  no gain table map: the file is developed as it always was\n");
        return;
    };
    println!(
        "  baseline exposure {:+.2} EV, tone curve of {} points, orientation {}",
        rendering.baseline_exposure,
        rendering.tone_curve.len(),
        raw_orientation(&bytes)
    );
    let opts = heeler_raw::DevelopOpts { half_size: true, ..Default::default() };
    let sensor = match heeler_raw::decode_sensor_with(&bytes, opts) {
        Ok(s) => s,
        Err(e) => {
            println!("  DECODE: FAILED -- {e:?}\n");
            return;
        }
    };
    let mut img = ImageBuf::new(sensor.width, sensor.height);
    for (px, rgb) in img.data.chunks_exact_mut(4).zip(sensor.rgb.chunks_exact(3)) {
        for c in 0..3 {
            px[c] = rgb[c] as f32 / 65535.0;
        }
        px[3] = 1.0;
    }
    let preview = match extract_raw_preview(&bytes).map(decode_bytes) {
        Some(Ok(p)) => p,
        Some(Err(e)) => {
            println!("  the embedded preview would not decode: {e}\n");
            return;
        }
        None => {
            println!("  no embedded preview to compare against\n");
            return;
        }
    };
    let preview = apply_orientation(preview, raw_orientation(&bytes));
    if (preview.width > preview.height) != (img.width > img.height) {
        println!("  NOTE: the develop and the preview disagree about which way is up");
    }
    let theirs = cells(&preview, 1.0);
    compare("as developed", &cells(&img, 1.3f32.exp2()), &theirs);
    // What 26.4.0 showed: the bare develop through the default profile.
    compare("old default", &cells(&profiled(&img), 1.0), &theirs);
    // The file's exposure and gain map without its curve, then the
    // default profile: the candidate for a file that names no curve.
    {
        let mut mapped = img.clone();
        let mut no_curve = rendering.clone();
        no_curve.tone_curve.clear();
        dng_gain::render(&mut mapped, &no_curve);
        let with_profile = profiled(&mapped);
        compare("map + profile", &cells(&with_profile, 1.0), &theirs);
        // The same gap as light: how many stops the picture as a whole
        // sits under (or over) the preview, by the median of the cells'
        // linear luma, which a few bright cells cannot pull.
        println!(
            "  in stops: map + profile {:+.2}, map alone {:+.2}, as the file renders {:+.2}",
            stops(&with_profile, &preview),
            stops(&mapped, &preview),
            stops(&{ let mut r = img.clone(); dng_gain::render(&mut r, &rendering); r }, &preview),
        );
        compare("map alone", &cells(&mapped, 1.0), &theirs);
    }
    // Review comparison: the same gain stage, with a curve per channel
    // instead of the reference renderer's hue-held interpolation.
    let mut per_channel = img.clone();
    let mut gain_only = rendering.clone();
    gain_only.tone_curve.clear();
    dng_gain::render(&mut per_channel, &gain_only);
    for px in per_channel.data.chunks_exact_mut(4) {
        for c in 0..3 { px[c] = curve_at(&rendering.tone_curve, px[c].clamp(0.0, 1.0)); }
    }
    compare("per channel", &cells(&per_channel, 1.0), &theirs);
    let started = std::time::Instant::now();
    dng_gain::render(&mut img, &rendering);
    let took = started.elapsed();
    compare("rendered", &cells(&img, 1.0), &theirs);
    compare("its color", &chroma_cells(&img), &chroma_cells(&preview));
    // GAINPROBE_OUT=<folder> writes the pair for the eye: ours on the
    // left, the phone's preview on the right.
    if let Some(out) = std::env::var_os("GAINPROBE_OUT") {
        let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let target = Path::new(&out).join(format!("{name}-ours-vs-preview.jpg"));
        match side_by_side(&img, &preview) {
            Ok(jpeg) => match std::fs::write(&target, jpeg) {
                Ok(()) => println!("  wrote {}", target.display()),
                Err(e) => println!("  could not write {}: {e}", target.display()),
            },
            Err(e) => println!("  could not encode the pair: {e}"),
        }
    }
    println!("  rendered {} x {} in {} ms\n", img.width, img.height, took.as_millis());
}

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("usage: gainprobe <file.dng>...");
        std::process::exit(2);
    }
    for f in &files {
        probe(Path::new(f));
    }
}

fn curve_at(curve: &[(f32, f32)], x: f32) -> f32 {
    if curve.is_empty() { return x; }
    if x <= curve[0].0 { return curve[0].1; }
    let hi = curve.partition_point(|p| p.0 <= x);
    if hi == curve.len() { return curve[hi - 1].1; }
    let (a,b) = (curve[hi - 1], curve[hi]);
    a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0)
}
