//! Highlight reconstruction, rendered so it can be judged by eye.
//!
//!     cargo run --release -p heeler-io --features libraw --example highlights -- <raw> [outdir]
//!
//! The M3.4 quality check needs a person to look at recovered highlights
//! and say whether they are right, and the numbers alone cannot answer
//! that: clip, blend and rebuild differ ONLY above scene white, which is
//! exactly the range a naive dump to PNG throws away. So this renders the
//! three modes through the shipped tone profile, whose shoulder is what
//! turns super-whites into visible detail, and crops to the region that
//! actually clips, found by looking rather than guessed at.
//!
//! It also pulls exposure down first, by -2 EV unless told otherwise.
//! That is not decoration: at the shipped baseline the tone curve
//! compresses everything above white into the top of the display range,
//! so all three modes render as the same flat white and the comparison
//! proves nothing. Pulling exposure is also what a photographer does when
//! recovering a blown sky, so it is the honest way to look at this.

use std::path::{Path, PathBuf};

use heeler_engine::{ops, ImageBuf, Value};
use heeler_graph::{Node, ParamValue, Section};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The rendering the app ships, from PROFILE_DEFAULTS in state.ts, which
/// is the calibration the owner signed off ("SHIP IT AS VERIFIED").
fn tone_profile_node() -> Node {
    let mut params = BTreeMap::new();
    params.insert("contrast".into(), ParamValue::Number(100.0));
    params.insert("baseline_ev".into(), ParamValue::Number(1.3));
    params.insert("shadow_toe".into(), ParamValue::Number(50.0));
    params.insert("highlight_rolloff".into(), ParamValue::Number(25.0));
    Node {
        id: "tone".into(),
        node_type: "heeler.tone_profile".into(),
        version: 1,
        label: "Tone Profile".into(),
        section: Section::RawFoundation,
        enabled: true,
        params,
        inputs: Vec::new(),
        outputs: Vec::new(),
    }
}

fn toned(img: &ImageBuf) -> ImageBuf {
    let node = tone_profile_node();
    let inputs = [("in".to_string(), Value::Image(Arc::new(img.clone())))];
    match ops::execute(&node, &inputs) {
        Ok(v) => v.as_image().map(|i| (**i).clone()).unwrap_or_else(|| img.clone()),
        Err(e) => {
            eprintln!("tone profile failed ({e}), showing scene-linear instead");
            img.clone()
        }
    }
}

/// The window with the most clipped pixels, which is where the three
/// modes can possibly differ. Searched on a coarse grid; precision here
/// buys nothing that the eye would notice.
fn clipped_window(img: &ImageBuf, side: usize) -> (usize, usize) {
    let step = (side / 4).max(32);
    let (mut best, mut at) = (0u32, (0usize, 0usize));
    let mut y = 0;
    while y + side <= img.height {
        let mut x = 0;
        while x + side <= img.width {
            let mut n = 0u32;
            let mut sy = y;
            while sy < y + side {
                let mut sx = x;
                while sx < x + side {
                    let p = img.pixel(sx, sy);
                    if p[0] >= 0.999 || p[1] >= 0.999 || p[2] >= 0.999 {
                        n += 1;
                    }
                    sx += 4;
                }
                sy += 4;
            }
            if n > best {
                best = n;
                at = (x, y);
            }
            x += step;
        }
        y += step;
    }
    eprintln!("  brightest window at {},{} ({best} clipped samples sampled)", at.0, at.1);
    at
}

fn crop(img: &ImageBuf, at: (usize, usize), side: usize) -> ImageBuf {
    let w = side.min(img.width);
    let h = side.min(img.height);
    let mut out = ImageBuf::new(w, h);
    for y in 0..h {
        for x in 0..w {
            out.set_pixel(x, y, img.pixel((at.0 + x).min(img.width - 1), (at.1 + y).min(img.height - 1)));
        }
    }
    out
}

fn shrink(img: &ImageBuf, max_edge: usize) -> ImageBuf {
    let k = (img.width.max(img.height) / max_edge).max(1);
    let (w, h) = (img.width / k, img.height / k);
    let mut out = ImageBuf::new(w.max(1), h.max(1));
    for y in 0..out.height {
        for x in 0..out.width {
            out.set_pixel(x, y, img.pixel(x * k, y * k));
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: highlights <raw file> [outdir]");
        std::process::exit(2);
    }
    let path = Path::new(&args[0]);
    let out_dir = args.get(1).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&out_dir).unwrap();
    let bytes = std::fs::read(path).unwrap();
    let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
    let ev: f32 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(-2.0);
    let gain_ev = 2f32.powf(ev);
    println!("rendering at {ev:+.1} EV");

    const SIDE: usize = 900;
    let mut window = None;
    for (label, highlight) in [("1-clip", 0), ("2-blend", 2), ("3-rebuild", 5)] {
        let opts = heeler_raw::DevelopOpts { highlight, ..heeler_raw::DevelopOpts::default() };
        let sensor = match heeler_raw::decode_sensor_with(&bytes, opts) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{label}: decode failed: {e}");
                continue;
            }
        };
        let gain = sensor.headroom.max(1.0);
        let mut img = ImageBuf::new(sensor.width, sensor.height);
        for px in 0..sensor.width * sensor.height {
            let (i, o) = (px * 3, px * 4);
            img.data[o] = sensor.rgb[i] as f32 / 65535.0 * gain;
            img.data[o + 1] = sensor.rgb[i + 1] as f32 / 65535.0 * gain;
            img.data[o + 2] = sensor.rgb[i + 2] as f32 / 65535.0 * gain;
            img.data[o + 3] = 1.0;
        }

        // The window is chosen once, on clip, so all three crops show the
        // same piece of the picture. Choosing per mode would compare
        // different subjects and prove nothing.
        let at = *window.get_or_insert_with(|| clipped_window(&img, SIDE));

        // Pull exposure before toning, so recovered highlights land where
        // the eye can see them instead of on the shoulder.
        for v in img.data.chunks_exact_mut(4) {
            for c in 0..3 {
                v[c] *= gain_ev;
            }
        }

        // What the crop actually contains, so a visually identical pair
        // can be told apart from a genuinely identical one.
        let detail_src = crop(&img, at, SIDE);
        let (mut mx, mut sum) = (0f32, 0f64);
        for px in detail_src.data.chunks_exact(4) {
            for v in &px[..3] {
                mx = mx.max(*v);
                sum += *v as f64;
            }
        }
        println!(
            "  {label}: crop mean {:.4}, max {:.4}",
            sum / (detail_src.data.len() / 4 * 3) as f64,
            mx
        );

        let full = out_dir.join(format!("{stem}-{label}-full.png"));
        std::fs::write(&full, heeler_io::encode_png(&shrink(&toned(&img), 1400)).unwrap()).unwrap();
        let detail = out_dir.join(format!("{stem}-{label}-detail.png"));
        std::fs::write(&detail, heeler_io::encode_png(&toned(&detail_src)).unwrap()).unwrap();
        println!("{label}: {} and {}", full.display(), detail.display());
    }
}
