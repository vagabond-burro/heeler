// A bench for the Depth Map section: decode a photograph the way the
// preview does, run the depth model, refine the plane at a few
// settings, and shade each plane with the real Depth Lighting op so
// the halos can be looked at side by side. Writes PNGs to a folder.
//
//   cargo run -p heeler-desktop --example depth_lab -- <photo> <vision base> <out dir> [edges,flatten ...]
//
// Review measurements, 2026-09-16: DEPTH_MEASURE=1 also writes
// little-endian f32 planes and interleaved RGB output/input ratios,
// before display encoding or clipping (NaN for zero input channels).
// Dimensions are printed below. DEPTH_RUNS=5 times five warm
// renders after the first; decoding, refinement and PNGs are outside
// the timer. DEPTH_PLANE=<far.f32> reuses a measured plane of the same
// preview size, so comparisons do not depend on another model run.
// DEPTH_LIGHT_ONLY=1 skips the unrelated Depth of Field render.
//
// Never shipped: an example, built on demand, for eyes only.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use heeler_engine::buffers::{ImageBuf, Value};
use heeler_engine::ops::{execute, to_display};
use heeler_graph::node::{ParamValue, Section};
use heeler_graph::Registry;

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

fn plane_image(plane: &[f32], w: usize, h: usize) -> ImageBuf {
    let mut img = ImageBuf::new(w, h);
    for (i, v) in plane.iter().enumerate() {
        img.data[i * 4] = *v;
        img.data[i * 4 + 1] = *v;
        img.data[i * 4 + 2] = *v;
        img.data[i * 4 + 3] = 1.0;
    }
    img
}

fn write(out: &Path, name: &str, bytes: Vec<u8>) {
    std::fs::write(out.join(name), bytes).expect("write png");
    println!("  wrote {name}");
}

fn num(node: &mut heeler_graph::node::Node, k: &str, v: f64) {
    node.params.insert(k.to_string(), ParamValue::Number(v));
}

fn floats(out: &Path, name: &str, values: impl Iterator<Item = f32>) {
    let bytes: Vec<u8> = values.flat_map(f32::to_le_bytes).collect();
    std::fs::write(out.join(name), bytes).expect("write floats");
}

fn render(node: &heeler_graph::node::Node, photo: &Arc<ImageBuf>, plane: &ImageBuf, out: &Path, name: &str) -> ImageBuf {
    let inputs = vec![
        ("in".to_string(), Value::Image(photo.clone())),
        ("raster".to_string(), Value::Image(Arc::new(plane.clone()))),
    ];
    let t = Instant::now();
    let result = execute(node, &inputs).expect("op runs");
    let cold = t.elapsed().as_secs_f64() * 1000.0;
    let runs: usize = std::env::var("DEPTH_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t = Instant::now();
        let repeated = execute(node, &inputs).expect("op runs");
        times.push(t.elapsed().as_secs_f64() * 1000.0);
        std::hint::black_box(&repeated);
    }
    times.sort_by(f64::total_cmp);
    println!("{name}: first {cold:.3} ms, warm median {:?} ms, samples {times:?}", times.get(times.len() / 2));
    let image = result.as_image().expect("image out");
    if std::env::var_os("DEPTH_MEASURE").is_some() {
        floats(out, &format!("{name}.gain-rgb.f32"), image.data.chunks_exact(4).zip(photo.data.chunks_exact(4)).flat_map(|(lit, src)| {
            std::array::from_fn::<_, 3, _>(|c| if src[c].abs() > 1e-8 { lit[c] / src[c] } else { f32::NAN })
        }));
    }
    (**image).clone()
}

fn shade(registry: &Registry, kind: &str, params: &[(&str, f64)], photo: &Arc<ImageBuf>, plane: &ImageBuf, out: &Path, name: &str) -> ImageBuf {
    let mut node = registry.instantiate(kind, "lab", Section::Creative).expect("known op");
    for (k, v) in params {
        num(&mut node, k, *v);
    }
    render(&node, photo, plane, out, name)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: depth_lab <photo> <vision base> <out dir> [edges,flatten ...]");
        std::process::exit(2);
    }
    let photo = Path::new(&args[1]);
    let base = Path::new(&args[2]);
    let out = Path::new(&args[3]);
    std::fs::create_dir_all(out).expect("out dir");
    let settings: Vec<(f32, f32)> = if args.len() > 4 {
        args[4..]
            .iter()
            .map(|s| {
                let mut it = s.split(',').map(|v| v.parse::<f32>().expect("number"));
                (it.next().unwrap() / 100.0, it.next().unwrap() / 100.0)
            })
            .collect()
    } else {
        vec![(0.0, 0.0), (0.5, 0.25), (1.0, 0.5), (1.0, 1.0)]
    };

    let t = Instant::now();
    let full = heeler_io::decode_preview(photo).expect("decode");
    println!("decoded {}x{} in {:?}", full.width, full.height, t.elapsed());
    let preview = Arc::new(downscale(&full, 2048));
    let (w, h) = (preview.width, preview.height);
    println!("preview {w}x{h}");
    write(out, "photo.png", heeler_io::encode_png(&preview).unwrap());

    let mut rgb = vec![0.0f32; w * h * 3];
    for (i, px) in preview.data.chunks(4).enumerate() {
        for c in 0..3 {
            rgb[i * 3 + c] = to_display(px[c].max(0.0)).min(1.0) * 255.0;
        }
    }
    let t = Instant::now();
    // DEPTH_WORK=700 or 1036 reads at the Depth Map section's larger sizes.
    let work: usize = std::env::var("DEPTH_WORK").ok().and_then(|v| v.parse().ok()).unwrap_or(518);
    let far = if let Some(path) = std::env::var_os("DEPTH_PLANE") {
        let bytes = std::fs::read(path).expect("cached plane");
        assert_eq!(bytes.len(), w * h * 4, "cached plane must match preview dimensions");
        bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect()
    } else {
        let mut est = heeler_vision::DepthEstimator::load(base, &heeler_vision::DEPTH_ANYTHING).expect("model");
        est.depth_at(&rgb, w, h, work).expect("depth")
    };
    println!("depth in {:?}", t.elapsed());
    if std::env::var_os("DEPTH_MEASURE").is_some() {
        floats(out, "far.f32", far.iter().copied());
    }

    let registry = Registry::builtin();
    let light: &[(&str, f64)] = &[("strength", 95.0), ("azimuth", 45.0), ("elevation", 45.0), ("ambient", 50.0), ("relief", 30.0)];
    let dof: &[(&str, f64)] = &[("aperture", 60.0), ("focus", 5.0)];
    for (edges, flatten) in settings {
        let tag = format!("e{:03}f{:03}", (edges * 100.0) as u32, (flatten * 100.0) as u32);
        let t = Instant::now();
        let plane = heeler_vision::refine_depth(&far, &rgb, w, h, edges, flatten);
        println!("{tag}: refine in {:?}", t.elapsed());
        let img = plane_image(&plane, w, h);
        if std::env::var_os("DEPTH_MEASURE").is_some() {
            floats(out, &format!("depth-{tag}.f32"), plane.iter().copied());
        }
        write(out, &format!("depth-{tag}.png"), heeler_io::encode_png_raw(&img).unwrap());
        let lit = shade(&registry, "heeler.key_light", light, &preview, &img, out, &format!("light-{tag}"));
        write(out, &format!("light-{tag}.png"), heeler_io::encode_png(&lit).unwrap());
        // The owner's rig of 2026-09-13: one directional dark light,
// hard.
        let dark: &[(&str, f64)] = &[("strength", -180.0), ("azimuth", 45.0), ("elevation", 45.0), ("ambient", 50.0), ("relief", 30.0)];
        let darkened = shade(&registry, "heeler.key_light", dark, &preview, &img, out, &format!("dark-{tag}"));
        write(out, &format!("dark-{tag}.png"), heeler_io::encode_png(&darkened).unwrap());
        // The owner's point lamp of 2026-09-13 (dark, at the pavement's
        // depth), bare and through the section's own Levels. LAMP=px,py places
        // it; the default sits on the pavement left of the subject.
        let lamp = std::env::var("LAMP").unwrap_or_else(|_| "0.4,0.8".into());
        let (px, py) = lamp.split_once(',').map(|(a, b)| (a.parse::<f64>().unwrap(), b.parse::<f64>().unwrap())).unwrap();
        let rig = format!("[{{\"kind\":\"point\",\"px\":{px},\"py\":{py},\"depth\":73,\"range\":58,\"strength\":-127}}]");
        let red = rig.replace("\"strength\":-127", "\"strength\":-127,\"color\":\"#ff0000\"");
        for (name, levels, lights) in [("point", 0.0, &rig), ("point-levels", 0.6, &rig), ("point-red", 0.0, &red)] {
            let mut node = registry.instantiate("heeler.key_light", "lab", Section::Creative).expect("known op");
            num(&mut node, "ambient", 91.0);
            num(&mut node, "relief", 30.0);
            num(&mut node, "depth_black", levels);
            node.params.insert("lights".to_string(), ParamValue::Text(lights.clone()));
            let lit = render(&node, &preview, &img, out, &format!("{name}-{tag}"));
            write(out, &format!("{name}-{tag}.png"), heeler_io::encode_png(&lit).unwrap());
        }
        if std::env::var_os("DEPTH_LIGHT_ONLY").is_none() {
            let blurred = shade(&registry, "heeler.dof", dof, &preview, &img, out, &format!("dof-{tag}"));
            write(out, &format!("dof-{tag}.png"), heeler_io::encode_png(&blurred).unwrap());
        }
    }
}
