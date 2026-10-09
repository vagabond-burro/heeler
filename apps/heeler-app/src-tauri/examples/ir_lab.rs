// A bench for the infrared conversion: decode photographs, run them
// through the spectral conversion as an infrared pair, and write each
// beside its color original so the prior can be judged on real frames
// before it costs a panel (2026-09-14: "Maybe I should see how well
// Heeler could simulate that effect").
//
//   cargo run -p heeler-desktop --example ir_lab -- OUT_DIR FILE...
//
// Each FILE becomes OUT_DIR/<name>_ir.png: four panels, the color
// original, the plain panchromatic conversion (HP5, no filter), a 720
// filter on Rollei Infrared 400 with the default prior, and an 850 on
// Kodak HIE. The prior is the engine's default; the panel's five
// materials and curve will let a user change it.

use std::path::Path;

use std::sync::Arc;

use heeler_engine::buffers::{ImageBuf, Value};
use heeler_engine::ops::execute;
use heeler_engine::spectral::Conversion;
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

/// The conversion through the node itself, the path the app renders,
/// which reads hue from the smoothed field; the per-pixel Conversion is
/// only the check it agrees with (the first bench used it directly and
/// so never showed the halo the app did).
fn convert_node(registry: &Registry, src: &ImageBuf, filter: &str, film: &str) -> ImageBuf {
    let mut node = registry.instantiate("heeler.black_white", "lab", Section::Creative).expect("known op");
    node.params.insert("amount".into(), ParamValue::Number(100.0));
    node.params.insert("filter".into(), ParamValue::Text(filter.into()));
    node.params.insert("film".into(), ParamValue::Text(film.into()));
    let inputs = vec![("in".to_string(), Value::Image(Arc::new(src.clone())))];
    let out = execute(&node, &inputs).expect("op runs");
    (**out.as_image().expect("image")).clone()
}

/// The conversion as a gray frame, pixel by pixel, for the plain
/// panchromatic panel.
fn convert(src: &ImageBuf, conv: Option<&Conversion>) -> ImageBuf {
    let mut out = ImageBuf::new(src.width, src.height);
    for i in 0..src.width * src.height {
        let p = &src.data[i * 4..i * 4 + 4];
        let g = match conv {
            Some(c) => c.gray(p[0], p[1], p[2]),
            None => heeler_engine::buffers::luma(p[0], p[1], p[2]),
        };
        let o = &mut out.data[i * 4..i * 4 + 4];
        o[0] = g;
        o[1] = g;
        o[2] = g;
        o[3] = 1.0;
    }
    out
}

fn side_by_side(panels: &[&ImageBuf]) -> ImageBuf {
    let w: usize = panels.iter().map(|p| p.width).sum::<usize>() + 8 * (panels.len() - 1);
    let h = panels.iter().map(|p| p.height).max().unwrap_or(1);
    let mut out = ImageBuf::filled(w, h, [0.02, 0.02, 0.02, 1.0]);
    let mut x0 = 0;
    for p in panels {
        for y in 0..p.height {
            for x in 0..p.width {
                let px = p.pixel(x, y);
                out.set_pixel(x0 + x, y, px);
            }
        }
        x0 += p.width + 8;
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: ir_lab OUT_DIR FILE...");
        std::process::exit(2);
    }
    let out_dir = Path::new(&args[0]);
    std::fs::create_dir_all(out_dir).expect("out dir");
    let registry = Registry::builtin();
    let pan = Conversion::new("", "hp5").expect("pan");
    let r72 = Conversion::new("r72", "rolleiir").expect("ir");
    let r85 = Conversion::new("r85", "hie").expect("deep ir");
    eprintln!(
        "infrared share: 720/Rollei {:.2}, 850/HIE {:.2}",
        r72.infrared_share(),
        r85.infrared_share()
    );
    for file in &args[1..] {
        let path = Path::new(file);
        let t0 = std::time::Instant::now();
        let src = match heeler_io::decode_any(path) {
            Ok(img) => img,
            Err(e) => {
                eprintln!("{file}: {e}");
                continue;
            }
        };
        let small = downscale(&src, 900);
        // The photograph's own brightness, lifted the way the profile
        // lifts a RAW, so a dark decode does not read as the film's doing.
        let colour = small.clone();
        let panels = [
            colour,
            convert(&small, Some(&pan)),
            convert_node(&registry, &small, "r72", "rolleiir"),
            convert_node(&registry, &small, "r85", "hie"),
        ];
        let sheet = side_by_side(&[&panels[0], &panels[1], &panels[2], &panels[3]]);
        let png = heeler_io::encode_png(&sheet).expect("png");
        let name = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "frame".into());
        let out = out_dir.join(format!("{name}_ir.png"));
        std::fs::write(&out, png).expect("write");
        eprintln!("{} -> {} ({} ms)", file, out.display(), t0.elapsed().as_millis());
    }
}
