//! The slider drag probe (a tester, 2026-09-30: "I do get a bit of
//! jitter/lag on the sliders (eg exposure)"). Replays a drag's worth of
//! gesture-tier renders the way render_preview_attempt makes them: the
//! preview decode at the rest edge shrunk to the gesture edge, the
//! persistent executor (its cache is what makes a drag cheap), one
//! render per value, each frame encoded as the q94 JPEG the viewer
//! receives. Reports per-frame render and encode time (the encoder the
//! viewer uses and, beside it, the image crate's it replaced), their spread, and
//! the frames past 33 ms. The frontend pump keeps one render in flight
//! and coalesces to the newest value, so the queue behind a render is at
//! most one frame: the interval between pictures is one frame's time.
//!
//! Ignored, and a no-op without the file:
//!   HEELER_SLIDER_RAW=<path to a RAW> HEELER_SLIDER_FRAMES=<n, default 120>
//!   HEELER_SLIDER_PARAM=<exposure|clarity, default exposure>
//!   HEELER_GPU=0 keeps the tail on the CPU
//!   HEELER_SLIDER_DUMP=<folder> writes one frame of each tier as PNG,
//!   the input the encoder comparisons were measured on
//!   cargo test -p heeler-desktop --lib slider_probe -- --ignored --nocapture
use super::*;
use std::path::PathBuf;

fn pct(v: &[f64], p: f64) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    s[((p * s.len() as f64) as usize).min(s.len() - 1)]
}

fn summary(name: &str, v: &[f64]) {
    let mean = v.iter().sum::<f64>() / v.len() as f64;
    let sd = (v.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
    eprintln!(
        "{name:>22}: p50 {:6.1}  p95 {:6.1}  max {:6.1}  mean {:6.1}  sd {:5.1}  over 33 ms {}",
        pct(v, 0.5), pct(v, 0.95), pct(v, 1.0), mean, sd, v.iter().filter(|x| **x > 33.0).count()
    );
}

#[test]
#[ignore]
fn slider_probe_gesture_drag() {
    let Some(raw) = std::env::var_os("HEELER_SLIDER_RAW").map(PathBuf::from).filter(|p| p.is_file()) else {
        eprintln!("HEELER_SLIDER_RAW not set or missing: skipped");
        return;
    };
    let frames: usize = std::env::var("HEELER_SLIDER_FRAMES").ok().and_then(|v| v.parse().ok()).unwrap_or(120);
    let which = std::env::var("HEELER_SLIDER_PARAM").unwrap_or_else(|_| "exposure".into());
    let base: UiGraph = serde_json::from_str(crate::quality_probe::FRESH_GRAPH).unwrap();
    let opts = source_opts_of(&base);
    let t = std::time::Instant::now();
    let rest = Arc::new(downscale(&heeler_io::decode_preview_at(&raw, opts, 2048).unwrap(), 2048));
    eprintln!("preview decode {}x{} in {} ms", rest.width, rest.height, t.elapsed().as_millis());
    let registry = Registry::builtin();

    for (tier, source) in [
        ("gesture@1024", Arc::new(downscale(&rest, 1024))),
        ("rest@2048", rest.clone()),
    ] {
        let mut sources = HashMap::new();
        sources.insert("src".to_string(), SourceImage { image: source.clone(), version: 1, measured: false });
        let mut exec = Executor::new();
        let gpu_tail = gpu_tail_of(&base);
        let gpu = if gpu_tail.is_some() { gpu_engine() } else { None };
        let (mut render_ms, mut encode_ms, mut total_ms) = (Vec::new(), Vec::new(), Vec::new());
        let (mut old_ms, mut old_bytes, mut new_bytes) = (Vec::new(), 0usize, 0usize);
        for i in 0..=frames {
            // There and back across the slider, as a hand drags it.
            let u = i as f64 / frames as f64;
            let tri = if u < 0.5 { u * 2.0 } else { 2.0 - u * 2.0 };
            let mut ui = base.clone();
            match which.as_str() {
                "clarity" => {
                    let n = ui.nodes.iter_mut().find(|n| n.id == "stdcolor").unwrap();
                    n.params.insert("clarity".into(), serde_json::json!(tri * 100.0));
                }
                _ => {
                    let n = ui.nodes.iter_mut().find(|n| n.id == "exposure").unwrap();
                    n.params.insert("exposure".into(), serde_json::json!(-3.0 + 6.0 * tri));
                }
            }
            let t0 = std::time::Instant::now();
            let g = build_graph(&ui, &registry).unwrap();
            let terminal = terminal_of(&ui).unwrap();
            let mut out = None;
            if let (Some((prefix, tail)), Some(gpu)) = (&gpu_tail, gpu) {
                let prefix_val = exec.render(&g, prefix, &sources).unwrap();
                let prefix_img = prefix_val.as_image().unwrap();
                let nodes: Vec<&heeler_graph::Node> = tail.iter().filter_map(|id| g.node(id))
                    .filter(|n| n.enabled && heeler_gpu::GpuEngine::supports(&n.node_type)).collect();
                let key = gpu_source_key(&g, prefix, &sources, prefix_img);
                if let Ok(img) = gpu.run_chain_keyed(key, &nodes, prefix_img) {
                    out = Some(Arc::new(img));
                }
            }
            let img = match out {
                Some(img) => img,
                None => exec.render(&g, &terminal, &sources).unwrap().as_image().unwrap().clone(),
            };
            let r = t0.elapsed().as_secs_f64() * 1000.0;
            // The encoder the viewer's frames go through, and beside it
            // the image crate's, which sent them until 2026-09-30.
            let t1 = std::time::Instant::now();
            let bytes = encode_preview_jpeg(&img, preview_jpeg_quality(false, None)).unwrap();
            let e = t1.elapsed().as_secs_f64() * 1000.0;
            assert!(!bytes.is_empty());
            let t2 = std::time::Instant::now();
            let old = heeler_io::encode_jpeg(&img, preview_jpeg_quality(false, None)).unwrap();
            let o = t2.elapsed().as_secs_f64() * 1000.0;
            (old_bytes, new_bytes) = (old.len(), bytes.len());
            if i == frames / 3 {
                if let Some(dir) = std::env::var_os("HEELER_SLIDER_DUMP").map(PathBuf::from) {
                    std::fs::create_dir_all(&dir).unwrap();
                    let name = tier.split('@').next().unwrap();
                    std::fs::write(dir.join(format!("{name}.png")), heeler_io::encode_png(&img).unwrap()).unwrap();
                    std::fs::write(dir.join(format!("{name}-old.jpg")), &old).unwrap();
                    std::fs::write(dir.join(format!("{name}-new.jpg")), &bytes).unwrap();
                }
            }
            // The first frame pays the cold upstream; a drag's frames after it are what the hand feels.
            if i > 0 {
                render_ms.push(r);
                encode_ms.push(e);
                old_ms.push(o);
                total_ms.push(r + e);
            }
        }
        eprintln!(
            "{tier} {}x{}, {which} drag, {frames} frames, backend {}",
            source.width, source.height,
            if gpu_tail.is_some() && gpu.is_some() { "gpu tail" } else { "cpu" }
        );
        summary("render", &render_ms);
        summary("old jpeg (image crate)", &old_ms);
        summary("jpeg q94 encode", &encode_ms);
        eprintln!("{:>22}: old {old_bytes} bytes, new {new_bytes} bytes", "last frame");
        summary("render + encode", &total_ms);
    }
}

/// The settle's encode, old encoder against the viewer's, on the whole
/// photograph at full resolution through the fresh graph: time, bytes,
/// and how far apart the two decodes land (they are the same quality and
/// sampling, so the difference is DCT rounding). Same file variable.
#[test]
#[ignore]
fn slider_probe_settle_encode() {
    let Some(raw) = std::env::var_os("HEELER_SLIDER_RAW").map(PathBuf::from).filter(|p| p.is_file()) else {
        eprintln!("HEELER_SLIDER_RAW not set or missing: skipped");
        return;
    };
    let base: UiGraph = serde_json::from_str(crate::quality_probe::FRESH_GRAPH).unwrap();
    let opts = source_opts_of(&base);
    let full = Arc::new(heeler_io::decode_any_with(&raw, opts).unwrap());
    let mut sources = HashMap::new();
    sources.insert("src".to_string(), SourceImage { image: full.clone(), version: 1, measured: false });
    let g = build_graph(&base, &Registry::builtin()).unwrap();
    let img = Executor::new().render(&g, &terminal_of(&base).unwrap(), &sources).unwrap().as_image().unwrap().clone();
    for q in [75u8, 85, 94] {
        let q = preview_jpeg_quality(true, Some(q));
        let (mut old_ms, mut new_ms) = (Vec::new(), Vec::new());
        let (mut old, mut new) = (Vec::new(), Vec::new());
        for _ in 0..5 {
            let t = std::time::Instant::now();
            old = heeler_io::encode_jpeg(&img, q).unwrap();
            old_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            let t = std::time::Instant::now();
            new = encode_preview_jpeg(&img, q).unwrap();
            new_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        let (a, b) = (heeler_io::decode_bytes(&old).unwrap(), heeler_io::decode_bytes(&new).unwrap());
        // [old against the source, new against the source, old against new]
        let mut err = [(0f64, 0u8); 3];
        let n = img.width * img.height;
        for p in 0..n {
            for c in 0..3 {
                let s = heeler_io::srgb_u8(img.data[p * 4 + c]);
                let (da, db) = (heeler_io::srgb_u8(a.data[p * 4 + c]), heeler_io::srgb_u8(b.data[p * 4 + c]));
                for (k, e) in [(0, s.abs_diff(da)), (1, s.abs_diff(db)), (2, da.abs_diff(db))] {
                    err[k].0 += e as f64;
                    err[k].1 = err[k].1.max(e);
                }
            }
        }
        let m = |k: usize| err[k].0 / (n * 3) as f64;
        eprintln!(
            "settle {}x{} q{q}: old {:.0} ms {} bytes, err mean {:.3} max {} | new {:.0} ms {} bytes, err mean {:.3} max {} | old vs new mean {:.3} max {}",
            img.width, img.height, pct(&old_ms, 0.5), old.len(), m(0), err[0].1, pct(&new_ms, 0.5), new.len(), m(1), err[1].1, m(2), err[2].1
        );
    }
}
