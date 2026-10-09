//! Reproducible synthetic 24 MP review bench. Run with --release.
//! Arguments: scenario (mixer, curve, film, ir, paper, grain, collision, split), width,
//! height, repeats. No decoding, GPU, UI or disk work is timed.
use heeler_engine::{ops, ImageBuf, Value};
use heeler_graph::{ParamValue, Registry, Section};
use std::{hint::black_box, sync::Arc, time::Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let scenario = args.get(1).map(String::as_str).unwrap_or("mixer");
    let w = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(6000);
    let h = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(4000);
    let repeats = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(3);
    let kind = match scenario { "paper" | "split" => "heeler.paper", "grain" => "heeler.grain", _ => "heeler.black_white" };
    let mut node = Registry::builtin().instantiate(kind, "test", Section::Creative).unwrap();
    node.params.insert("amount".into(), ParamValue::Number(100.0));
    match scenario {
        "curve" => { node.params.insert("hue_curve".into(), ParamValue::Text(r#"[{"x":20,"y":0.5},{"x":150,"y":-0.5},{"x":260,"y":0}]"#.into())); }
        "film" => { node.params.insert("film".into(), ParamValue::Text("hp5".into())); }
        "ir" => {
            node.params.insert("film".into(), ParamValue::Text("rolleiir".into()));
            node.params.insert("filter".into(), ParamValue::Text("r72".into()));
        }
        "grain" => {
            node.params.insert("intensity".into(), ParamValue::Number(18.0));
            node.params.insert("size".into(), ParamValue::Number(30.0));
            node.params.insert("by_frame".into(), ParamValue::Bool(true));
        }
        "split" => {
            node.params.insert("split".into(), ParamValue::Bool(true));
            node.params.insert("soft".into(), ParamValue::Number(2.0));
            node.params.insert("hard".into(), ParamValue::Number(-2.0));
        }
        _ => {}
    }
    let mut src = ImageBuf::new(w, h);
    for y in 0..h { for x in 0..w {
        let a = x as f32 / w as f32;
        let b = y as f32 / h as f32;
        src.set_pixel(x, y, [0.02 + a * 0.8, 0.04 + b * 0.7, 0.1 + (1.0 - a) * 0.6, 1.0]);
        if scenario == "split" {
            let v = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.6][x % 8];
            src.set_pixel(x, y, [v, v, v, 1.0]);
        }
    }}
    let inputs = [("in".to_string(), Value::Image(Arc::new(src)))];
    if scenario == "collision" {
        let converted = ops::execute(&node, &inputs).unwrap();
        for i in 0..repeats {
            let start = Instant::now();
            let result = heeler_engine::collision_overlay(converted.as_image().unwrap(), inputs[0].1.as_image().unwrap(), None, 1).unwrap();
            let elapsed = start.elapsed().as_secs_f64() * 1000.0;
            black_box(&result);
            println!("{scenario} {w}x{h} run={} ms={elapsed:.3}", i + 1);
        }
        return;
    }
    for i in 0..repeats {
        let start = Instant::now();
        let result = ops::execute(&node, &inputs).unwrap();
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        black_box(&result);
        println!("{scenario} {w}x{h} run={} ms={elapsed:.3}", i + 1);
        if scenario == "split" { println!("split ramp: {:?}", result.as_image().unwrap().data.chunks_exact(4).take(8).map(|p| p[0]).collect::<Vec<_>>()); }
    }
}
