//! How long a GPU tail takes on the preview's frame, its source uploaded
//! fresh and kept on the card, against the CPU running the same nodes.
//! Run by hand in release.
use heeler_engine::{executor::Executor, ImageBuf, SourceImage, Value};
use heeler_graph::{Graph, ParamValue, Registry, Section};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

fn main() {
    let gpu = heeler_gpu::GpuEngine::new().expect("a GPU");
    let r = Registry::builtin();
    let (w, h) = (2048usize, 1365usize);
    let mut img = ImageBuf::new(w, h);
    for (i, px) in img.data.chunks_exact_mut(4).enumerate() {
        let v = (i % 997) as f32 / 997.0;
        px.copy_from_slice(&[v, 1.0 - v, 0.5, 1.0]);
    }
    let mut exp = r.instantiate("heeler.exposure", "exp", Section::Creative).unwrap();
    exp.params.insert("exposure".into(), ParamValue::Number(0.4));
    let profile = r.instantiate("heeler.tone_profile", "tp", Section::Creative).unwrap();
    let nodes = [&exp, &profile];
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    for round in 0..3 {
        let t = Instant::now();
        gpu.run_chain_keyed(Some(1000 + round), &nodes, &img).unwrap();
        let fresh = ms(t);
        let t = Instant::now();
        gpu.run_chain_keyed(Some(1000 + round), &nodes, &img).unwrap();
        let kept = ms(t);
        println!("gpu tail of 2 at {w}x{h}: source uploaded {fresh:.1} ms, source kept {kept:.1} ms");
    }
    let mut g = Graph::new("cpu");
    g.add_node(r.instantiate("heeler.image_source", "src", Section::Creative).unwrap()).unwrap();
    g.add_node(exp.clone()).unwrap();
    g.add_node(profile.clone()).unwrap();
    g.connect("src", "out", "exp", "in").unwrap();
    g.connect("exp", "out", "tp", "in").unwrap();
    let sources = HashMap::from([("src".to_string(), SourceImage { image: Arc::new(img.clone()), version: 1, measured: false })]);
    for _ in 0..3 {
        let t = Instant::now();
        let v = Executor::new().render(&g, "tp", &sources).unwrap();
        let cpu = ms(t);
        if let Value::Image(i) = v { assert_eq!(i.width, w) }
        println!("cpu same 2 nodes: {cpu:.1} ms");
    }
}
