//! Graph cards take the render lock one card at a time and come from
//! the executor's cache when the preview already computed them (the
//! groups-scale review's R8).
use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn node(id: &str, kind: &str, params: serde_json::Value) -> UiNode {
    UiNode { id: id.into(), node_type: format!("heeler.{kind}"), enabled: true, params: serde_json::from_value(params).unwrap() }
}
fn wire(from: &str, to: &str) -> UiConnection {
    UiConnection { from: (from.into(), "out".into()), to: (to.into(), "in".into()) }
}
fn photo(size: usize) -> HashMap<String, SourceImage> {
    let mut img = ImageBuf::new(size, size);
    for y in 0..size {
        for x in 0..size {
            let v = ((x * 7 + y * 3) % 97) as f32 / 97.0;
            img.set_pixel(x, y, [v, 1.0 - v, 0.5, 1.0]);
        }
    }
    HashMap::from([("src".to_string(), SourceImage { image: Arc::new(img), version: 1, measured: false })])
}

#[test]
fn a_preview_waits_one_card_not_the_pass() {
    // Six slow cards, each its own wide blur off the photograph.
    let ids: Vec<String> = (0..6).map(|i| format!("b{i}")).collect();
    let mut ui = UiGraph { graph_id: "cards".into(), nodes: vec![node("src", "image_source", serde_json::json!({}))], connections: vec![] };
    for (i, id) in ids.iter().enumerate() {
        ui.nodes.push(node(id, "blur", serde_json::json!({"radius": 40 + i})));
        ui.connections.push(wire("src", id));
    }
    let g = build_graph(&ui, &Registry::builtin()).unwrap();
    let sources = photo(1024);
    let lock = Arc::new(tauri::async_runtime::Mutex::new(()));
    let slot = Arc::new(Mutex::new(Executor::new()));
    let started = Arc::new(AtomicBool::new(false));
    let done = Arc::new(AtomicBool::new(false));
    let slowest = Arc::new(Mutex::new(std::time::Duration::ZERO));
    let pass = {
        let (lock, slot, started, done, slowest, g, sources, ids) = (lock.clone(), slot.clone(), started.clone(), done.clone(), slowest.clone(), g.clone(), sources.clone(), ids.clone());
        std::thread::spawn(move || {
            let pass = card_pass(&ids, 64, &lock, |id| Executor::key_of(&g, id, &sources).ok(), |key| slot.lock().unwrap().get(key), |id| {
                started.store(true, Ordering::SeqCst);
                let t = std::time::Instant::now();
                let mut exec = std::mem::take(&mut *slot.lock().unwrap());
                let value = exec.render(&g, id, &sources).ok();
                *slot.lock().unwrap() = exec;
                let took = t.elapsed();
                let mut worst = slowest.lock().unwrap();
                *worst = (*worst).max(took);
                value
            });
            done.store(true, Ordering::SeqCst);
            pass
        })
    };
    while !started.load(Ordering::SeqCst) {
        std::thread::yield_now();
    }
    // The preview asks for the lock while the first card renders.
    let asked = std::time::Instant::now();
    let guard = lock.blocking_lock();
    let waited = asked.elapsed();
    // The mechanism: the lock was free between cards, so the preview got
    // it while cards were still to come.
    assert!(!done.load(Ordering::SeqCst), "the preview waited for the whole pass ({waited:?})");
    drop(guard);
    let pass = pass.join().unwrap();
    assert_eq!(pass.rendered, 6);
    let slowest = *slowest.lock().unwrap();
    eprintln!("preview waited {waited:?}; slowest card {slowest:?}");
    // Four times the fixed allowance on Linux, which runs on a slower VM.
    let slack = if cfg!(target_os = "linux") { 4 } else { 1 };
    assert!(waited <= slowest * 2 + std::time::Duration::from_millis(50 * slack), "waited {waited:?} against one card's {slowest:?}");
}

#[test]
fn an_upstream_card_after_a_downstream_edit_comes_from_the_cache() {
    let ui = |radius: f64| UiGraph {
        graph_id: "cards".into(),
        nodes: vec![
            node("src", "image_source", serde_json::json!({})),
            node("a", "exposure", serde_json::json!({"exposure": 0.5})),
            node("b", "blur", serde_json::json!({"radius": radius})),
            node("out", "output", serde_json::json!({})),
        ],
        connections: vec![wire("src", "a"), wire("a", "b"), wire("b", "out")],
    };
    let sources = photo(256);
    let mut exec = Executor::new();
    // The preview before the edit computes everything once.
    exec.render(&build_graph(&ui(4.0), &Registry::builtin()).unwrap(), "out", &sources).unwrap();
    // A slider release on b: the cards for a (upstream) and b (edited).
    let g = build_graph(&ui(9.0), &Registry::builtin()).unwrap();
    let slot = Mutex::new(exec);
    let before = slot.lock().unwrap().stats.executions.get("a").copied();
    let renders = AtomicUsize::new(0);
    let lock = tauri::async_runtime::Mutex::new(());
    let pass = card_pass(&["a".into(), "b".into()], 64, &lock, |id| Executor::key_of(&g, id, &sources).ok(), |key| slot.lock().unwrap().get(key), |id| {
        renders.fetch_add(1, Ordering::SeqCst);
        slot.lock().unwrap().render(&g, id, &sources).ok()
    });
    assert_eq!((pass.from_cache, pass.rendered), (1, 1), "a from the cache, b rendered");
    assert_eq!(renders.load(Ordering::SeqCst), 1, "no render call, no render lock, for the upstream card");
    assert_eq!(slot.lock().unwrap().stats.executions.get("a").copied(), before, "a did not execute again");
    assert_eq!(pass.cards.len(), 2);
}
