//! a run of undos at 1:1 held the picture seconds behind. The viewer
//! asks for a fresh full-resolution slice on every edit and cancels
//! the one before, but the full tier rendered on a bare executor that
//! never read the token, so each obsolete slice ran to the end behind
//! the render lock (the owner's log: nine slices back to back at 1.1 s
//! each after the undos). These tests hold the full tier to the token
//! and time a burst the way the viewer sends it.
use super::*;

fn node(id: &str, ty: &str, params: serde_json::Value) -> UiNode {
    UiNode {
        id: id.into(),
        node_type: ty.into(),
        enabled: true,
        params: serde_json::from_value(params).unwrap(),
    }
}

fn wire(a: &str, b: &str) -> UiConnection {
    UiConnection { from: (a.into(), "out".into()), to: (b.into(), "in".into()) }
}

/// A chain of wide blurs standing in for the expensive tail of a slice:
/// enough nodes that "stopped between nodes" and "ran to the end" are
/// far apart in time.
fn chain(links: usize) -> (heeler_graph::Graph, HashMap<String, SourceImage>) {
    let mut nodes = vec![node("src", "heeler.image_source", serde_json::json!({}))];
    let mut connections = Vec::new();
    let mut prev = "src".to_string();
    for i in 0..links {
        let id = format!("blur{i}");
        nodes.push(node(&id, "heeler.blur", serde_json::json!({ "radius": 24.0 + i as f64 })));
        connections.push(wire(&prev, &id));
        prev = id;
    }
    nodes.push(node("output", "heeler.output", serde_json::json!({})));
    connections.push(wire(&prev, "output"));
    let ui = UiGraph { graph_id: "render-cancel".into(), nodes, connections };
    let mut img = ImageBuf::new(1600, 1200);
    for y in 0..img.height {
        for x in 0..img.width {
            let v = 0.2 + 0.6 * (((x / 37) + (y / 23)) % 2) as f32;
            img.set_pixel(x, y, [v, v * 0.9, v * 0.8, 1.0]);
        }
    }
    let sources = HashMap::from([(
        "src".to_string(),
        SourceImage { image: Arc::new(img), version: 11, measured: false },
    )]);
    (build_graph(&ui, &Registry::builtin()).unwrap(), sources)
}

#[test]
fn a_canceled_full_tier_render_stops_instead_of_running_to_the_end() {
    let (g, sources) = chain(8);
    // The pair (whole render, canceled render) is measured up to three
    // times: on a loaded machine the cancel's delivery can be delayed
    // past where the render would have ended anyway, which says nothing
    // about the stop (every attempt still must come back canceled). One
    // clean pair proves the render stops between nodes.
    let mut stopped_early = false;
    for attempt in 0..3 {
        // Uncanceled, the full tier renders to the end.
        let t0 = std::time::Instant::now();
        full_tier_executor(Some(format!("render-cancel:whole:{attempt}"))).render(&g, "output", &sources).unwrap();
        let whole = t0.elapsed();

        // A slice the viewer replaced a moment after asking: the token is
        // marked while the render is under way.
        let token = format!("render-cancel:mid:{attempt}");
        let guard = RenderToken::start(token.clone()).unwrap();
        let marker = {
            let token = token.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(5));
                tauri::async_runtime::block_on(cancel_render(token)).unwrap();
            })
        };
        let t1 = std::time::Instant::now();
        let result = full_tier_executor(Some(token.clone())).render(&g, "output", &sources);
        let stopped = t1.elapsed();
        marker.join().unwrap();
        drop(guard);
        eprintln!("full tier: whole render {} ms, canceled 5 ms in: {} ms", whole.as_millis(), stopped.as_millis());
        assert!(
            matches!(result, Err(heeler_engine::EngineError::Cancelled)),
            "a canceled full-resolution render must stop between nodes (whole render took {} ms)",
            whole.as_millis()
        );
        stopped_early |= stopped < whole;
    }
    assert!(stopped_early, "the canceled render never stopped short of the whole render in three pairs");
}

#[test]
fn a_request_canceled_while_it_waited_for_the_lock_never_starts() {
    let token = "render-cancel:queued".to_string();
    let guard = RenderToken::start(token.clone()).unwrap();
    assert_eq!(canceled_before_start(Some(&token)), Ok(()));
    tauri::async_runtime::block_on(cancel_render(token.clone())).unwrap();
    assert_eq!(canceled_before_start(Some(&token)).unwrap_err(), "render canceled");
    // The ladder reads the same words and does not retry them.
    let mut calls = 0;
    let _ = retry_preview::<()>(None, |_| {
        calls += 1;
        canceled_before_start(Some(&token))
    });
    assert_eq!(calls, 1);
    drop(guard);
    assert_eq!(canceled_before_start(None), Ok(()));
}

/// The burst the viewer sends: one slice request per undo, each
/// canceled by the next, and the last one wanted. The parent's full
/// tier (a bare executor) rendered every one of them; now only the
/// last renders, so the burst costs one render, the same as a fresh
/// open's.
#[test]
fn a_burst_of_undos_renders_the_last_slice_once() {
    let (g, sources) = chain(8);
    const UNDOS: usize = 8;
    let burst = |executor: &dyn Fn(Option<String>) -> Executor| {
        let t0 = std::time::Instant::now();
        let mut rendered = 0;
        for i in 0..UNDOS {
            let token = format!("render-cancel:burst:{i}:{}", t0.elapsed().as_nanos());
            let guard = RenderToken::start(token.clone()).unwrap();
            // Every request but the last was replaced before its turn
            // at the lock came round.
            if i + 1 < UNDOS {
                tauri::async_runtime::block_on(cancel_render(token.clone())).unwrap();
            }
            if canceled_before_start(Some(&token)).is_ok()
                && executor(Some(token.clone())).render(&g, "output", &sources).is_ok()
            {
                rendered += 1;
            }
            drop(guard);
        }
        (rendered, t0.elapsed())
    };
    // The parent: the queued requests reached the executor (no check
    // before start) and it never read the token.
    let (before_n, before) = {
        let t0 = std::time::Instant::now();
        let mut n = 0;
        for _ in 0..UNDOS {
            if Executor::new().render(&g, "output", &sources).is_ok() { n += 1; }
        }
        (n, t0.elapsed())
    };
    let (after_n, after) = burst(&|t| full_tier_executor(t));
    let t0 = std::time::Instant::now();
    full_tier_executor(None).render(&g, "output", &sources).unwrap();
    let fresh = t0.elapsed();
    eprintln!(
        "{UNDOS} undos at 1:1: parent {before_n} renders in {} ms, now {after_n} in {} ms; one fresh render {} ms",
        before.as_millis(), after.as_millis(), fresh.as_millis()
    );
    assert_eq!(before_n, UNDOS);
    assert_eq!(after_n, 1, "only the last request of a burst renders");
}

/// Every executor the preview attempt builds reads the render's token:
/// the full tier's bare Executor::new() is how the 1:1 slice and the
/// settle came to ignore cancel_render while the reduced tier obeyed it.
#[test]
fn every_executor_in_the_preview_attempt_reads_the_cancel_token() {
    let src = include_str!("lib.rs");
    let start = src.find("fn render_preview_attempt(").expect("attempt present");
    let end = start + src[start..].find("\n}\n").expect("attempt ends");
    let body = &src[start..end];
    assert!(
        !body.contains("Executor::new()"),
        "render_preview_attempt builds a bare executor; use full_tier_executor or PreviewExecutor with render_stop"
    );
    assert!(body.contains("full_tier_executor(cancel_token.clone())"));
    assert!(body.contains("exec.set_stop(render_stop(cancel_token.clone()))"));
}
