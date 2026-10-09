//! The scripting bridge: Heeler's command bus over local JSON-RPC.
//!
//! One door of two (the MCP door comes later, over these same
//! handlers). A loopback-only HTTP server takes {method, params},
//! answers what it can natively (registry, ping, render), and forwards
//! everything stateful to the frontend, which executes it against the
//! SAME reducers the UI uses and answers back. That is the whole
//! design: the API is a remote hand on the one command bus, so nothing
//! is scriptable that the UI cannot do, every mutation validates the
//! same way, and script actions land in the user's own undo history.
//!
//! Off by default, started from Preferences. The discovery file
//! (~/.heeler/api.json) tells clients where the door is and carries the
//! token that opens it; loopback binding keeps the network out of it.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::Emitter;

#[derive(Clone, Serialize)]
pub struct ApiStatus {
    pub port: u16,
    pub token: String,
}

struct Running {
    status: ApiStatus,
    transport: crate::api_transport::Transport,
}

/// Requests waiting on the frontend, by id. The bridge thread parks on
/// the receiving end; the frontend's api_respond releases it.
type Pending = Mutex<HashMap<u64, SyncSender<serde_json::Value>>>;

fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn running() -> &'static Mutex<Option<Running>> {
    static R: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Where clients find the door. Home rather than app-data, because the
/// person writing a Python script should not need to know Tauri's
/// directory conventions.
pub fn discovery_path() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".heeler").join("api.json"))
}

/// The machine-readable node registry: every type, param, range and
/// port. Python introspection and (later) an agent tool manifest both
/// read this, which is why it lives here and not in the frontend: the
/// Rust registry is the authority the engine actually enforces.
pub fn registry_manifest() -> serde_json::Value {
    let reg = heeler_graph::Registry::builtin();
    let nodes: Vec<serde_json::Value> = reg
        .types()
        .filter_map(|name| reg.get(name))
        .map(|spec| {
            serde_json::json!({
                "type": spec.type_name,
                "label": spec.label,
                "version": spec.version,
                "params": spec.params.iter().map(|p| {
                    let (hard_lo, hard_hi) = heeler_graph::spec::hard_limits(p);
                    serde_json::json!({
                        "name": p.name,
                        "default": p.default,
                        // The slider's span, and what may actually be
                        // set: the two ranges the UI itself honors.
                        "min": p.min,
                        "max": p.max,
                        "hard_min": if hard_lo.is_finite() { Some(hard_lo) } else { None },
                        "hard_max": if hard_hi.is_finite() { Some(hard_hi) } else { None },
                    })
                }).collect::<Vec<_>>(),
                "inputs": spec.inputs,
                "outputs": spec.outputs,
            })
        })
        .collect();
    serde_json::json!({ "heeler": 1, "nodes": nodes })
}

/// How long the bridge waits on the frontend for a given method.
///
/// Ten seconds is generous for a reducer dispatch and short enough
/// that a hung webview fails the script rather than wedging it. Export
/// and merge calls are real minutes of work, not dispatches, so they
/// get a horizon sized to the job: the timeout exists to fail a wedged
/// webview, never to cut an honest batch off halfway.
fn frontend_timeout(method: &str) -> std::time::Duration {
    match method {
        "export.run" => std::time::Duration::from_secs(3600),
        "stack.create" | "stack.bake" | "pano.create" => std::time::Duration::from_secs(600),
        _ => std::time::Duration::from_secs(10),
    }
}

/// Asks the frontend to run one method and waits for the answer.
pub fn ask_frontend(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    stop: &AtomicBool,
) -> Result<serde_json::Value, String> {
    if stop.load(Ordering::Acquire) {
        return Err("API stopped".into());
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = sync_channel(1);
    pending()
        .lock()
        .map_err(|_| "pending poisoned")?
        .insert(id, tx);
    let _cleanup = PendingRequest(id);
    app.emit(
        "heeler-api",
        serde_json::json!({ "id": id, "method": method, "params": params }),
    )
    .map_err(|e| e.to_string())?;
    let v = wait_frontend(rx, stop, frontend_timeout(method))?;
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_string());
    }
    Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

struct PendingRequest(u64);
impl Drop for PendingRequest {
    fn drop(&mut self) {
        if let Ok(mut requests) = pending().lock() {
            requests.remove(&self.0);
        }
    }
}
fn wait_frontend(
    rx: Receiver<serde_json::Value>,
    stop: &AtomicBool,
    timeout: std::time::Duration,
) -> Result<serde_json::Value, String> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if stop.load(Ordering::Acquire) {
            return Err("API stopped".into());
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("frontend did not answer".into());
        }
        match rx.recv_timeout(remaining.min(std::time::Duration::from_millis(50))) {
            Ok(value) => return Ok(value),
            Err(RecvTimeoutError::Timeout) => {}
            Err(_) => return Err("frontend did not answer".into()),
        }
    }
}

/// The frontend's reply path.
fn api_respond_in(id: u64, result: serde_json::Value) {
    if let Some(tx) = pending().lock().ok().and_then(|mut p| p.remove(&id)) {
        let _ = tx.send(result);
    }
}

#[tauri::command]
pub async fn api_respond(id: u64, result: serde_json::Value) {
    let _ = tauri::async_runtime::spawn_blocking(move || api_respond_in(id, result)).await;
}

/// One request, answered. Native methods short-circuit; everything else
/// rides to the frontend.
fn handle(
    app: &tauri::AppHandle,
    method: &str,
    params: serde_json::Value,
    stop: &AtomicBool,
) -> Result<serde_json::Value, String> {
    match method {
        "app.ping" => Ok(serde_json::json!({ "heeler": 1, "app": "heeler" })),
        "registry.nodes" => Ok(registry_manifest()),
        // Render: the frontend serializes its live graph, the engine
        // renders it here, and the bytes come back base64. Pixels stay
        // on the Rust side; the webview never shuttles megabytes.
        "render.preview" => {
            let g = ask_frontend(app, "graph.serialize", serde_json::Value::Null, stop)?;
            let ui: crate::UiGraph =
                serde_json::from_value(g.get("graph").cloned().ok_or("no graph in serialization")?)
                    .map_err(|e| e.to_string())?;
            let image_id = g
                .get("imageId")
                .and_then(|v| v.as_str())
                .ok_or("no active image")?
                .to_string();
            let registry = heeler_graph::Registry::builtin();
            let opts = crate::source_opts_of(&ui);
            let source = crate::preview_source(app, &image_id, opts)?;
            let mut sources = HashMap::new();
            sources.insert(
                "src".to_string(),
                crate::SourceImage {
                    image: source.clone(),
                    version: 1,
                    measured: false,
                },
            );
            for n in ui
                .nodes
                .iter()
                .filter(|n| n.node_type == "heeler.image_source")
            {
                if n.id != "src" {
                    if let Some(s) = sources.get("src").cloned() {
                        sources.insert(n.id.clone(), s);
                    }
                }
            }
            // The preview's own tiers and scales, per branch, so the
            // scripted render is the frame the viewer shows.
            let graph = crate::plant_and_build(app, &image_id, &ui, &registry, &source, false, &mut sources)?;
            let mut exec = heeler_engine::executor::Executor::new();
            let target = params
                .get("node")
                .and_then(|v| v.as_str())
                .unwrap_or("output")
                .to_string();
            let out = exec
                .render(&graph, &target, &sources)
                .map_err(|e| e.to_string())?;
            let img = out.as_image().ok_or("target is not an image")?;
            let quality = params.get("quality").and_then(|v| v.as_u64()).unwrap_or(92) as u8;
            let bytes = heeler_io::encode_jpeg(img, quality).map_err(|e| e.to_string())?;
            use base64::Engine as _;
            Ok(serde_json::json!({
                "format": "jpeg",
                "width": img.width,
                "height": img.height,
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }))
        }
        _ => ask_frontend(app, method, params, stop),
    }
}

#[tauri::command]
pub async fn api_start(app: tauri::AppHandle) -> Result<ApiStatus, String> {
    // The command seat is a worker job like every other; ensure_started
    // stays synchronous because the Python console reaches it from
    // already-async commands, where the main thread is not in play.
    tauri::async_runtime::spawn_blocking(move || ensure_started(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Starts the bridge if it is not already up and returns where it is.
/// The Preferences toggle and the Python console both come through
/// here, which is what keeps them the same door.
pub fn ensure_started(app: &tauri::AppHandle) -> Result<ApiStatus, String> {
    let app = app.clone();
    let mut run = running().lock().map_err(|_| "api lock poisoned")?;
    if let Some(r) = run.as_ref() {
        return Ok(r.status.clone());
    }
    let token = crate::serve::mint_token();
    let transport = crate::api_transport::Transport::start(
        token.clone(),
        Arc::new(move |method, params, stop| handle(&app, method, params, stop)),
    )?;
    let status = ApiStatus {
        port: transport.port,
        token: token.clone(),
    };
    let port = status.port;

    // The discovery file: where the door is, and the key.
    if let Some(path) = discovery_path() {
        let _ = std::fs::create_dir_all(path.parent().unwrap());
        let _ = std::fs::write(
            &path,
            serde_json::json!({ "port": port, "token": token, "pid": std::process::id() })
                .to_string(),
        );
    }

    *run = Some(Running {
        status: status.clone(),
        transport,
    });
    Ok(status)
}

#[tauri::command]
pub async fn api_stop() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut run = running().lock().map_err(|_| "api lock poisoned")?;
        if let Some(mut r) = run.take() {
            r.transport.shutdown();
        }
        if let Some(path) = discovery_path() {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_wait_is_cancelled_by_stop_and_pending_entry_is_removed() {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(1);
        pending().lock().unwrap().insert(id, tx);
        let flag = AtomicBool::new(true);
        {
            let _cleanup = PendingRequest(id);
            assert_eq!(
                wait_frontend(rx, &flag, frontend_timeout("export.run")).unwrap_err(),
                "API stopped"
            );
        }
        assert!(!pending().lock().unwrap().contains_key(&id));
        api_respond_in(id, serde_json::json!({"data": "late"}));
    }
    #[test]
    fn failed_emit_cleanup_and_frontend_timeout_do_not_leave_pending_requests() {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(1);
        pending().lock().unwrap().insert(id, tx);
        {
            let _failed_emit_cleanup = PendingRequest(id);
        }
        assert!(!pending().lock().unwrap().contains_key(&id));
        assert!(wait_frontend(rx, &AtomicBool::new(false), std::time::Duration::ZERO).is_err());
    }

    #[test]
    fn the_manifest_carries_every_node_with_ranges_and_ports() {
        let m = registry_manifest();
        let nodes = m.get("nodes").and_then(|n| n.as_array()).unwrap();
        // The registry is the authority; the manifest must not sample it.
        let expected = heeler_graph::Registry::builtin().types().count();
        assert_eq!(nodes.len(), expected, "manifest and registry must agree");
        assert!(expected >= 50, "sanity: the registry is not tiny");
        let blend = nodes
            .iter()
            .find(|n| n["type"] == "heeler.blend")
            .expect("blend in manifest");
        let inputs: Vec<&str> = blend["inputs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["name"].as_str().unwrap())
            .collect();
        assert!(inputs.contains(&"clip"), "ports serialize: {inputs:?}");
        // The two-range rule survives serialization: exposure's slider
        // stops at 5, its hard range does not.
        let exposure = nodes
            .iter()
            .find(|n| n["type"] == "heeler.exposure")
            .unwrap();
        let p = exposure["params"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == "exposure")
            .unwrap();
        assert_eq!(p["max"], 5.0);
        assert!(p["hard_max"].is_null(), "no editorial ceiling on typing");
    }

    #[test]
    fn api_respond_releases_the_waiting_request() {
        let (tx, rx) = sync_channel(1);
        pending().lock().unwrap().insert(777, tx);
        api_respond_in(777, serde_json::json!({ "data": 42 }));
        assert_eq!(rx.recv().unwrap()["data"], 42);
        assert!(pending().lock().unwrap().get(&777).is_none());
    }
}
