// The README's depth figures: three photographs, each with its depth map
// and one depth tool rendered by the real ops on the real plane, the way
// the preview renders them (decode, the depth model at the Depth Map
// section's default size, refinement, the op). The browser build cannot
// render an edit, so these come from here.
//
//   cargo run -p heeler-desktop --example readme_depth -- <demo photos> <vision base> <out dir>
//
// <demo photos> is apps/heeler-app/src/demo-photos; <vision base> the
// app data folder's vision folder, where the depth model is installed.
// Writes, per figure, <name>-before.png, <name>-depth.png and
// <name>-after.png. Never shipped: an example, built on demand.

use std::path::Path;
use std::sync::Arc;

use heeler_engine::buffers::{ImageBuf, Value};
use heeler_engine::ops::{execute, to_display};
use heeler_graph::node::{ParamValue, Section};
use heeler_graph::Registry;

const LONG_EDGE: usize = 1600;

fn downscale(src: &ImageBuf, long_edge: usize) -> ImageBuf {
    let scale = long_edge as f32 / src.width.max(src.height) as f32;
    if scale >= 1.0 {
        return src.clone();
    }
    let nw = ((src.width as f32 * scale).round() as usize).max(1);
    let nh = ((src.height as f32 * scale).round() as usize).max(1);
    let mut out = ImageBuf::new(nw, nh);
    for y in 0..nh {
        let y0 = (y as f32 / scale) as usize;
        let y1 = (((y + 1) as f32 / scale) as usize).min(src.height).max(y0 + 1);
        for x in 0..nw {
            let x0 = (x as f32 / scale) as usize;
            let x1 = (((x + 1) as f32 / scale) as usize).min(src.width).max(x0 + 1);
            let mut acc = [0.0f32; 4];
            let mut n = 0.0;
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let p = src.pixel(sx, sy);
                    for c in 0..4 {
                        acc[c] += p[c];
                    }
                    n += 1.0;
                }
            }
            let i = (y * nw + x) * 4;
            for c in 0..4 {
                out.data[i + c] = acc[c] / n;
            }
        }
    }
    out
}

/// The plane as the Depth Map section shows it: white near, black far.
fn plane_view(plane: &[f32], w: usize, h: usize) -> ImageBuf {
    let mut img = ImageBuf::new(w, h);
    for (i, v) in plane.iter().enumerate() {
        let near = 1.0 - v.clamp(0.0, 1.0);
        img.data[i * 4..i * 4 + 4].copy_from_slice(&[near, near, near, 1.0]);
    }
    img
}

fn plane_raster(plane: &[f32], w: usize, h: usize) -> ImageBuf {
    let mut img = ImageBuf::new(w, h);
    for (i, v) in plane.iter().enumerate() {
        img.data[i * 4..i * 4 + 4].copy_from_slice(&[*v, *v, *v, 1.0]);
    }
    img
}

struct Figure {
    name: &'static str,
    photo: &'static str,
    op: &'static str,
    params: Vec<(&'static str, f64)>,
    /// Depth Lighting's rig, as the section saves it.
    lights: Option<&'static str>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: readme_depth <demo photos> <vision base> <out dir>");
        std::process::exit(2);
    }
    let photos = Path::new(&args[1]);
    let base = Path::new(&args[2]);
    let out = Path::new(&args[3]);
    std::fs::create_dir_all(out).expect("out dir");
    let only = std::env::var("FIGURE").ok();
    let registry = Registry::builtin();
    let mut estimator = heeler_vision::DepthEstimator::load(base, &heeler_vision::DEPTH_ANYTHING).expect("depth model");
    let figures = [
        // A low warm sun from the right, raking across the columns by
        // the relief the depth map gives them.
        Figure {
            name: "depth-lighting",
            photo: "demo-01.jpg",
            op: "heeler.key_light",
            params: vec![("ambient", 50.0), ("relief", 45.0)],
            lights: Some(r##"[{"kind":"directional","azimuth":150,"elevation":15,"power":100,"color":"#ffc27a"}]"##),
        },
        Figure {
            name: "fog",
            photo: "demo-03.jpg",
            op: "heeler.fog",
            params: vec![("density", 70.0), ("start", 10.0), ("falloff", 55.0), ("fog_level", 78.0), ("fog_hue", 25.0), ("fog_sat", 18.0)],
            lights: None,
        },
        Figure {
            name: "depth-of-field",
            photo: "demo-02.jpg",
            op: "heeler.dof",
            params: vec![("aperture", 70.0), ("focus", 35.0)],
            lights: None,
        },
    ];
    for fig in figures {
        if only.as_deref().is_some_and(|o| o != fig.name) {
            continue;
        }
        let full = heeler_io::decode_preview(&photos.join(fig.photo)).expect("decode");
        let photo = Arc::new(downscale(&full, LONG_EDGE));
        let (w, h) = (photo.width, photo.height);
        let mut rgb = vec![0.0f32; w * h * 3];
        for (i, px) in photo.data.chunks(4).enumerate() {
            for c in 0..3 {
                rgb[i * 3 + c] = to_display(px[c].max(0.0)).min(1.0) * 255.0;
            }
        }
        let far = estimator.depth_at(&rgb, w, h, 518).expect("depth");
        let plane = heeler_vision::refine_depth(&far, &rgb, w, h, 0.5, 0.25);
        let mut node = registry.instantiate(fig.op, "readme", Section::Creative).expect("known op");
        for (k, v) in &fig.params {
            node.params.insert(k.to_string(), ParamValue::Number(*v));
        }
        if let Some(rig) = std::env::var("RIG").ok().or(fig.lights.map(String::from)) {
            node.params.insert("lights".into(), ParamValue::Text(rig));
        }
        let inputs = vec![
            ("in".to_string(), Value::Image(photo.clone())),
            ("raster".to_string(), Value::Image(Arc::new(plane_raster(&plane, w, h)))),
        ];
        let result = execute(&node, &inputs).expect("op runs");
        let after = result.as_image().expect("image out");
        let write = |suffix: &str, bytes: Vec<u8>| {
            let name = format!("{}-{suffix}.png", fig.name);
            std::fs::write(out.join(&name), bytes).expect("write png");
            println!("  wrote {name}");
        };
        write("before", heeler_io::encode_png(&photo).unwrap());
        write("depth", heeler_io::encode_png_raw(&plane_view(&plane, w, h)).unwrap());
        write("after", heeler_io::encode_png(after).unwrap());
    }
}
