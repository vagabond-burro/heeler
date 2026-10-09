//! Run after the frontend fixture exports the actual default graph.
use heeler_engine::{memory, Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};
use std::{collections::HashMap, sync::Arc, time::Instant};

#[test]
#[ignore = "200 full-resolution CPU renders in each of two memory budgets"]
fn bench_preview_drags() {
    let ui: serde_json::Value = serde_json::from_str(&std::fs::read_to_string("/tmp/heeler-phase6-default-graph.json").expect("run HEELER_PERF=1 frontend fixture first")).unwrap();
    let registry = Registry::builtin();
    let mut graph = Graph::new("default-drag");
    for n in ui["nodes"].as_array().unwrap() {
        let mut node = registry.instantiate(n["type"].as_str().unwrap(), n["id"].as_str().unwrap(), Section::Creative).unwrap();
        node.enabled = n["enabled"].as_bool().unwrap();
        for (k, v) in n["params"].as_object().unwrap() {
            if let Some(old) = node.params.get(k) {
                let value = match old {
                    ParamValue::Bool(_) => ParamValue::Bool(v.as_f64().unwrap() != 0.0),
                    ParamValue::Text(_) => ParamValue::Text(v.as_str().unwrap().into()),
                    _ => ParamValue::Number(v.as_f64().unwrap()),
                };
                node.params.insert(k.clone(), value);
            }
        }
        graph.add_node(node).unwrap();
    }
    for c in ui["connections"].as_array().unwrap() {
        graph.connect(c["from"][0].as_str().unwrap(), c["from"][1].as_str().unwrap(), c["to"][0].as_str().unwrap(), c["to"][1].as_str().unwrap()).unwrap();
    }
    for limit in [memory::budget().snapshot().limit, 4usize << 30] {
        memory::with_budget(limit, || {
            let mut image = ImageBuf::new(6000, 4000);
            for y in 0..4000 { for x in 0..6000 {
                image.set_pixel(x,y,[0.01 + x as f32 / 6000.0, 0.01 + y as f32 / 4000.0, 0.18, 1.0]);
            }}
            let image = Arc::new(image);
            memory::budget().track_image(&image);
            let sources = HashMap::from([("src".into(), SourceImage { image, version: 1, measured: false })]);
            let mut graph = graph.clone();
            let mut executor = Executor::new();
            executor.trim_bytes(1_500_000_000);
            let mut times = Vec::new();
            let mut admissions = Vec::new();
            let mut hash = 0u64;
            for step in 0..200 {
                graph.set_param("exposure", "exposure", ParamValue::Number(step as f64 / 100.0 - 1.0)).unwrap();
                let admission = Instant::now();
                { let _job = memory::Job::admit(executor.estimate(&graph,"output",&sources).unwrap(),"drag admission probe").unwrap(); }
                admissions.push(admission.elapsed().as_secs_f64()*1e6);
                let t = Instant::now();
                let Value::Image(output) = executor.render(&graph,"output",&sources).unwrap() else { panic!("image required") };
                executor.trim_bytes(1_500_000_000);
                executor.track_cache();
                times.push(t.elapsed().as_secs_f64() * 1000.0);
                hash = hash.wrapping_mul(16777619) ^ output.data[12000].to_bits() as u64;
                memory::budget().snapshot();
            }
            times.sort_by(f64::total_cmp);
            admissions.sort_by(f64::total_cmp);
            println!("admission budget_gib={} median_us={:.3} p95_us={:.3}",limit>>30,admissions[100],admissions[189]);
            let m = memory::budget().snapshot();
            println!("preview-drags budget_gib={} steps=200 min_ms={:.3} median_ms={:.3} p95_ms={:.3} accounted_peak_bytes={} retained_bytes={} check={hash}", limit >> 30, times[0], (times[99]+times[100])/2.0, times[189], m.peak, m.resident);
        });
    }
}
