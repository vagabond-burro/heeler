//! Served views: a collection as a read-only gallery on the local
//! network.
//!
//! From the tester who asked: "it's a view into the catalog so it can
//! be independent." Independence is structural here: by the time the
//! server thread exists, everything it will ever serve is a file in a
//! snapshot directory plus an in-memory manifest. It holds no catalog
//! connection, no engine handle, and no write path of any kind, so
//! serving cannot interfere with editing and a request cannot change a
//! photograph.
//!
//! The frontend drives the snapshot the same way batch export works:
//! it renders each member through its own saved graph into the serve
//! directory (the export pipeline, metadata and ICC included), then
//! starts the server over the finished files. A share is therefore as
//! stale as its start time, which v1 accepts and the spec documents:
//! refresh = restart.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServeItem {
    pub id: String,
    pub name: String,
    /// Bumped when the app re-renders this image into the share (the
    /// LIVE option). The gallery polls the manifest and re-fetches
    /// exactly the images whose version moved.
    #[serde(default)]
    pub v: u64,
}

#[derive(Clone, Serialize)]
pub struct ServeStatus {
    pub name: String,
    pub url: String,
    pub count: usize,
}

/// What the manifest serves: the items with their versions, and which
/// image is "live" (active in the editor) for the proofing page.
/// Mutated by the app through bump()/set_live(); the server thread only
/// ever reads it, which is the no-interference rule holding.
struct Shared {
    items: Vec<ServeItem>,
    live: Option<String>,
}

struct Running {
    status: ServeStatus,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    /// where the snapshot lives, so live re-renders know where to land
    dir: PathBuf,
}

fn running() -> &'static Mutex<Option<Running>> {
    static SERVE: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    SERVE.get_or_init(|| Mutex::new(None))
}

/// The share's snapshot folder, when a share is up. The app writes live
/// re-renders here; None means nothing is being served.
pub fn share_dir() -> Option<PathBuf> {
    running().lock().ok()?.as_ref().map(|r| r.dir.clone())
}

/// Whether the current share includes this image: the cheap question a
/// caller asks BEFORE paying for a re-render.
pub fn share_contains(id: &str) -> bool {
    running()
        .lock()
        .ok()
        .and_then(|g| {
            g.as_ref()
                .and_then(|r| r.shared.lock().ok().map(|s| s.items.iter().any(|i| i.id == id)))
        })
        .unwrap_or(false)
}

/// Marks an image as re-rendered (its file in the share folder has been
/// replaced) and optionally as the live one. Returns false when the
/// image is not part of the current share, so callers can skip the
/// render for photos nobody is looking at.
pub fn bump(id: &str, make_live: bool) -> bool {
    let guard = running().lock().ok();
    let Some(run) = guard.as_ref().and_then(|g| g.as_ref()) else {
        return false;
    };
    let Ok(mut shared) = run.shared.lock() else {
        return false;
    };
    let mut found = false;
    for item in shared.items.iter_mut() {
        if item.id == id {
            item.v += 1;
            found = true;
        }
    }
    if make_live && found {
        shared.live = Some(id.to_string());
    }
    found
}

/// A token nobody guesses by accident. Not cryptography, and does not
/// pretend to be: the threat model is "anyone on your network
/// with the link can view", said out loud in the UI.
pub(crate) fn mint_token() -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    std::process::id().hash(&mut h);
    let a = h.finish();
    a.hash(&mut h);
    format!("{:016x}{:016x}", a, h.finish())
}

/// The machine's LAN address, found by asking the OS how it would route
/// outward (no packet is sent). Falls back to localhost, which still
/// works for trying the gallery on the same machine.
fn lan_ip() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            s.connect("192.168.255.255:80")?;
            Ok(s.local_addr()?.ip().to_string())
        })
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn escape(name: &str) -> String {
    name.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// The gallery page, in both its lives.
///
/// Served (token given): the manifest drives the grid AND keeps
/// driving it, polled every couple of seconds so a live share swaps in
/// re-rendered images as the edit lands. Static (no token): the same
/// page written to disk with relative paths and no scripts beyond the
/// initial build, thumbnails in the grid linking to full images, ready
/// for any web host. One generator, because two galleries that drift
/// apart would each be worse than either.
fn gallery_html(name: &str, token: Option<&str>) -> String {
    let name = escape(name);
    let (base, tagline) = match token {
        Some(t) => (format!("/t/{t}/"), "served by Heeler, view only"),
        None => (String::new(), "made with Heeler"),
    };
    // Static galleries render a real thumbnail file; the share serves
    // one size and the grid shows it scaled. WebP both ways: half the
    // bytes of the JPEG this used to be.
    let thumb_src = match token {
        Some(_) => format!("'{base}img/' + encodeURIComponent(it.id) + '.webp' + bust(it)"),
        None => format!("'{base}thumbs/' + encodeURIComponent(it.id) + '.webp'"),
    };
    // Served tiles open the VIEW page rather than the file: a raw image URL
    // cannot refresh, and the owner found exactly that on the iPad. Static
    // galleries keep the direct link; nothing refreshes a static site.
    let tile_href = match token {
        Some(_) => format!("'{base}view/' + encodeURIComponent(it.id)"),
        None => format!("'{base}img/' + encodeURIComponent(it.id) + '.webp'"),
    };
    let poll = match token {
        Some(_) => format!(
            r#"
const seen = {{}};
function bust(it) {{ return it.v ? ('?v=' + it.v) : ''; }}
function refresh() {{
  fetch('{base}manifest.json').then(r => r.json()).then(m => {{
    for (const it of m.items) {{
      if (seen[it.id] !== undefined && seen[it.id] !== (it.v || 0)) {{
        const img = document.getElementById('i-' + it.id);
        if (img) img.src = {thumb_src};
      }}
      seen[it.id] = it.v || 0;
    }}
  }}).catch(() => {{}});
}}
setInterval(refresh, 2500);"#
        ),
        None => String::from("function bust() { return ''; }"),
    };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} - Heeler</title>
<style>
body {{ margin:0; background:#161412; color:#cbc7c2; font:14px system-ui, sans-serif; }}
header {{ padding:14px 18px; font-size:16px; letter-spacing:.04em; border-bottom:1px solid #2c2a28; }}
header small {{ color:#7a766f; margin-left:10px; }}
.grid {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:6px; padding:6px; }}
.grid a {{ display:block; background:#1c1a18; }}
.grid img {{ width:100%; height:220px; object-fit:cover; display:block; }}
.grid figcaption {{ font-size:11px; color:#918e8a; padding:4px 6px 6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }}
</style></head><body>
<header>{name}<small>{tagline}</small></header>
<div class="grid" id="g"></div>
<script>
{poll}
fetch('{base}manifest.json').then(r => r.json()).then(m => {{
  const g = document.getElementById('g');
  for (const it of m.items) {{
    const a = document.createElement('a');
    a.id = 'a-' + it.id;
    a.href = {tile_href};
    const f = document.createElement('figure'); f.style.margin = '0';
    const img = document.createElement('img');
    img.id = 'i-' + it.id;
    img.loading = 'lazy';
    img.src = {thumb_src};
    img.alt = it.name;
    const c = document.createElement('figcaption');
    c.textContent = it.name;
    f.appendChild(img); f.appendChild(c); a.appendChild(f); g.appendChild(a);
  }}
}});
</script></body></html>"#
    )
}

/// The proofing page: whatever photo is active in Heeler, full screen,
/// refreshed as edits land. "What if I want someone to
/// view the edits from a browser on their ipad."
fn live_html(name: &str, token: &str) -> String {
    let name = escape(name);
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} - live - Heeler</title>
<style>
html, body {{ margin:0; height:100%; background:#0e0d0c; }}
img {{ width:100%; height:100%; object-fit:contain; display:block; }}
#idle {{ color:#7a766f; font:14px system-ui, sans-serif; text-align:center; padding-top:40vh; }}
</style></head><body>
<div id="idle">Waiting for a photo to go live in Heeler...</div>
<img id="p" style="display:none" alt="">
<script>
let shown = null, v = -1;
function refresh() {{
  fetch('/t/{token}/manifest.json').then(r => r.json()).then(m => {{
    if (!m.live) return;
    const it = m.items.find(x => x.id === m.live);
    const nv = it ? (it.v || 0) : 0;
    if (m.live === shown && nv === v) return;
    shown = m.live; v = nv;
    const p = document.getElementById('p');
    p.src = '/t/{token}/img/' + encodeURIComponent(m.live) + '.webp?v=' + nv;
    p.style.display = 'block';
    document.getElementById('idle').style.display = 'none';
  }}).catch(() => {{}});
}}
setInterval(refresh, 1500);
refresh();
</script></body></html>"#
    )
}

/// One photo, full size, still refreshing: what a served gallery tile
/// opens. A raw image URL is a dead end ("it opens the jpg
/// directly"); this page shows the same image THROUGH the manifest, so
/// live edits keep arriving even at full size.
fn view_html(name: &str, token: &str, id: &str) -> String {
    let name = escape(name);
    let id_json = serde_json::json!(id).to_string();
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{name} - Heeler</title>
<style>
html, body {{ margin:0; height:100%; background:#0e0d0c; }}
img {{ width:100%; height:100%; object-fit:contain; display:block; }}
a {{ position:fixed; top:10px; left:12px; color:#918e8a; font:12px system-ui, sans-serif; text-decoration:none; background:rgba(14,13,12,.55); padding:4px 10px; border-radius:3px; }}
</style></head><body>
<a href="/t/{token}/">&#8592; {name}</a>
<img id="p" alt="">
<script>
const id = {id_json};
let v = -1;
function refresh() {{
  fetch('/t/{token}/manifest.json').then(r => r.json()).then(m => {{
    const it = m.items.find(x => x.id === id);
    const nv = it ? (it.v || 0) : 0;
    if (nv === v) return;
    v = nv;
    document.getElementById('p').src = '/t/{token}/img/' + encodeURIComponent(id) + '.webp?v=' + nv;
  }}).catch(() => {{}});
}}
setInterval(refresh, 2000);
refresh();
</script></body></html>"#
    )
}

/// The static gallery's files, minus the images: index.html and the
/// manifest, written beside the img/ and thumbs/ folders the caller
/// has already filled. The classic web-gallery gesture: the folder is the
/// deliverable, FTP it anywhere.
pub fn write_gallery(dir: &Path, name: &str, items: &[ServeItem]) -> Result<(), String> {
    let manifest = serde_json::json!({ "name": name, "items": items });
    std::fs::write(dir.join("manifest.json"), manifest.to_string()).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("index.html"), gallery_html(name, None)).map_err(|e| e.to_string())?;
    Ok(())
}

fn respond(
    req: tiny_http::Request,
    status: u16,
    content_type: &str,
    body: Vec<u8>,
) {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes())
        .expect("static header");
    let _ = req.respond(
        tiny_http::Response::from_data(body)
            .with_status_code(status)
            .with_header(header),
    );
}

/// Routes one request. Everything unknown is 404 with no detail: a
/// wrong token learns nothing, not even that it was a token.
///
/// `simple` drops the gate: any path outside the token prefix is
/// redirected into it, so the address a person shares is the bare
/// ip:port. "Why can't for simple home use can I just
/// have the IP and Port?" The token still anchors the internal
/// routes; it simply stops being something a guest has to know.
fn handle(
    req: tiny_http::Request,
    token: &str,
    simple: bool,
    name: &str,
    dir: &Path,
    shared: &Mutex<Shared>,
) {
    let url = req.url().to_string();
    let prefix = format!("/t/{token}");
    let Some(rest) = url.strip_prefix(&prefix) else {
        if simple {
            let target = format!("{prefix}/");
            let header =
                tiny_http::Header::from_bytes(&b"Location"[..], target.as_bytes()).unwrap();
            let _ = req.respond(
                tiny_http::Response::from_data(Vec::new()).with_status_code(303).with_header(header),
            );
            return;
        }
        return respond(req, 404, "text/plain", b"not found".to_vec());
    };
    // Live re-fetches carry a cache-busting query; routing ignores it.
    let rest = rest.split('?').next().unwrap_or(rest);
    match rest {
        "" | "/" => {
            let html = gallery_html(name, Some(token));
            respond(req, 200, "text/html; charset=utf-8", html.into_bytes())
        }
        "/live" | "/live/" => {
            let html = live_html(name, token);
            respond(req, 200, "text/html; charset=utf-8", html.into_bytes())
        }
        _ if rest.starts_with("/view/") => {
            let id = urldecode(rest.trim_start_matches("/view/"));
            let known = shared
                .lock()
                .map(|s| s.items.iter().any(|i| i.id == id))
                .unwrap_or(false);
            if !known {
                return respond(req, 404, "text/plain", b"not found".to_vec());
            }
            let html = view_html(name, token, &id);
            respond(req, 200, "text/html; charset=utf-8", html.into_bytes())
        }
        "/manifest.json" => {
            let body = match shared.lock() {
                Ok(s) => {
                    serde_json::json!({ "name": name, "items": s.items, "live": s.live }).to_string()
                }
                Err(_) => return respond(req, 404, "text/plain", b"not found".to_vec()),
            };
            respond(req, 200, "application/json", body.into_bytes())
        }
        _ => {
            // /img/{id}.jpg and /thumb/{id}.jpg serve the same render;
            // the LAN can afford it and the grid lazy-loads.
            let id = rest
                .strip_prefix("/img/")
                .or_else(|| rest.strip_prefix("/thumb/"))
                // WebP now; .jpg accepted so an old bookmark still lands.
                .and_then(|f| f.strip_suffix(".webp").or_else(|| f.strip_suffix(".jpg")));
            let Some(id) = id else {
                return respond(req, 404, "text/plain", b"not found".to_vec());
            };
            let decoded = urldecode(id);
            // Only ids from the snapshot are servable: the id list is
            // the whole filesystem surface, so a crafted path cannot
            // reach outside the serve directory.
            let known = shared
                .lock()
                .map(|s| s.items.iter().any(|i| i.id == decoded))
                .unwrap_or(false);
            if !known {
                return respond(req, 404, "text/plain", b"not found".to_vec());
            }
            let path = dir.join(format!("{}.webp", crate::sanitize_id(&decoded)));
            match std::fs::File::open(&path) {
                Ok(mut f) => {
                    let mut buf = Vec::new();
                    if f.read_to_end(&mut buf).is_ok() {
                        respond(req, 200, "image/webp", buf)
                    } else {
                        respond(req, 404, "text/plain", b"not found".to_vec())
                    }
                }
                Err(_) => respond(req, 404, "text/plain", b"not found".to_vec()),
            }
        }
    }
}

fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// The port a share asks for first. Stable on purpose: a link pinned
/// to the family fridge should survive a restart. When something else
/// holds it, the caller falls back to an OS-picked port and the URL
/// changes, which the banner shows.
pub const PREFERRED_PORT: u16 = 4335; // HEEL, on a phone keypad

/// The install's standing share token, minted once and kept in a file,
/// so the whole address (ip, port, token) repeats across restarts.
/// Whoever wants yesterday's link dead can delete the file; a fresh
/// token is minted on the next share.
pub fn persistent_token(root: &Path) -> String {
    let file = root.join("share-token");
    if let Ok(t) = std::fs::read_to_string(&file) {
        let t = t.trim().to_string();
        if t.len() >= 16 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t;
        }
    }
    let t = mint_token();
    let _ = std::fs::create_dir_all(root);
    let _ = std::fs::write(&file, &t);
    t
}

/// Starts serving `dir` as the gallery for `name`. Any previous share
/// stops first: one view at a time. `token` carries the
/// persistent one for a stable address; None mints a fresh one.
pub fn start(
    name: String,
    items: Vec<ServeItem>,
    dir: PathBuf,
    bind: &str,
    token: Option<String>,
    simple: bool,
) -> Result<ServeStatus, String> {
    stop();
    let token = token.unwrap_or_else(mint_token);
    let server = tiny_http::Server::http(bind).map_err(|e| e.to_string())?;
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    // Simple sharing advertises the bare address; the server redirects
    // into the token routes on arrival.
    let url = if simple {
        format!("http://{}:{}/", lan_ip(), port)
    } else {
        format!("http://{}:{}/t/{}/", lan_ip(), port, token)
    };
    let status = ServeStatus { name: name.clone(), url, count: items.len() };
    let stop_flag = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(Mutex::new(Shared { items, live: None }));
    let flag = stop_flag.clone();
    let served = shared.clone();
    let serve_dir = dir.clone();
    std::thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            match server.recv_timeout(std::time::Duration::from_millis(300)) {
                Ok(Some(req)) => handle(req, &token, simple, &name, &serve_dir, &served),
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    *running().lock().unwrap() = Some(Running { status: status.clone(), stop: stop_flag, shared, dir });
    Ok(status)
}

pub fn stop() {
    if let Some(r) = running().lock().unwrap().take() {
        r.stop.store(true, Ordering::Relaxed);
    }
}

pub fn status() -> Option<ServeStatus> {
    running().lock().unwrap().as_ref().map(|r| r.status.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The server slot is process-global (one share at a time is the
    /// FEATURE), so tests that start and stop shares must not overlap:
    /// start() stops whatever is running, including the other test's
    /// server mid-request. Surfaced as a once-a-day flake before this.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static L: OnceLock<Mutex<()>> = OnceLock::new();
        L.get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    fn get(url: &str) -> (u16, Vec<u8>) {
        // A hand-rolled GET keeps the test dependency-free; the server
        // is plain HTTP/1.1 on localhost.
        use std::io::Write;
        let addr = url.strip_prefix("http://").unwrap();
        let (host, path) = addr.split_once('/').unwrap();
        let mut s = std::net::TcpStream::connect(host).unwrap();
        write!(s, "GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).unwrap();
        let text = String::from_utf8_lossy(&buf);
        let code: u16 = text.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body_at = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        (code, buf[body_at..].to_vec())
    }

    /// Simple sharing: the advertised link is the bare address, and a guest
    /// landing on any path is redirected into the gallery. "Why
    /// can't for simple home use can I just have the IP and Port?"
    #[test]
    fn simple_sharing_advertises_ip_and_port_and_redirects_in() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("one.webp"), b"fake webp bytes").unwrap();
        let items = vec![ServeItem { id: "one".into(), name: "One.RW2".into(), v: 0 }];
        let st = start("Home".into(), items, dir.path().to_path_buf(), "127.0.0.1:0", None, true)
            .unwrap();
        assert!(!st.url.contains("/t/"), "the shared link is bare: {}", st.url);
        let port = st.url.split(':').nth(2).unwrap().trim_end_matches('/');
        let base = format!("http://127.0.0.1:{port}");
        // The root redirects into the token routes rather than 404ing.
        let (code, _) = get(&format!("{base}/"));
        assert_eq!(code, 303, "the bare address hands the guest to the gallery");
        stop();
    }

    #[test]
    fn serves_the_snapshot_and_nothing_else() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("one.webp"), b"fake webp bytes").unwrap();
        let items = vec![ServeItem { id: "one".into(), name: "One.RW2".into(), v: 0 }];
        let st = start("Family".into(), items, dir.path().to_path_buf(), "127.0.0.1:0", None, false).unwrap();
        assert!(st.url.contains("/t/"));
        assert_eq!(st.count, 1);
        // The status URL advertises the LAN address; the test talks to
        // the loopback the server is actually bound to.
        let base = format!(
            "http://127.0.0.1:{}",
            st.url.split(':').nth(2).unwrap().split('/').next().unwrap()
        );
        let token = st.url.split("/t/").nth(1).unwrap().trim_end_matches('/');

        let (code, body) = get(&format!("{base}/t/{token}/"));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("Family"));

        let (code, body) = get(&format!("{base}/t/{token}/manifest.json"));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("One.RW2"));

        let (code, body) = get(&format!("{base}/t/{token}/img/one.webp"));
        assert_eq!(code, 200);
        assert_eq!(body, b"fake webp bytes");

        // Wrong token, unknown id, and traversal attempts all read as
        // the same empty 404.
        assert_eq!(get(&format!("{base}/t/wrongtoken/")).0, 404);
        assert_eq!(get(&format!("{base}/t/{token}/img/other.webp")).0, 404);
        assert_eq!(get(&format!("{base}/t/{token}/img/..%2Fone.webp")).0, 404);

        stop();
        assert!(status().is_none());
    }

    #[test]
    fn live_updates_ride_the_manifest() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("one.webp"), b"v1").unwrap();
        let items = vec![ServeItem { id: "one".into(), name: "One.RW2".into(), v: 0 }];
        let st = start("Family".into(), items, dir.path().to_path_buf(), "127.0.0.1:0", None, false).unwrap();
        let base = format!(
            "http://127.0.0.1:{}",
            st.url.split(':').nth(2).unwrap().split('/').next().unwrap()
        );
        let token = st.url.split("/t/").nth(1).unwrap().trim_end_matches('/');

        // Before anything goes live: versions at zero, live null.
        let (_, body) = get(&format!("{base}/t/{token}/manifest.json"));
        let m: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(m["items"][0]["v"], 0);
        assert!(m["live"].is_null());

        // The app replaces the file and bumps; the manifest tells the
        // pollers, and the proofing page knows who is on stage.
        assert!(share_contains("one"));
        std::fs::write(dir.path().join("one.webp"), b"v2 pixels").unwrap();
        assert!(bump("one", true));
        let (_, body) = get(&format!("{base}/t/{token}/manifest.json"));
        let m: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(m["items"][0]["v"], 1);
        assert_eq!(m["live"], "one");

        // Cache-busted fetches route like plain ones and read the new file.
        let (code, body) = get(&format!("{base}/t/{token}/img/one.webp?v=1"));
        assert_eq!(code, 200);
        assert_eq!(body, b"v2 pixels");

        // The proofing page is served; an id outside the share bumps nothing.
        let (code, body) = get(&format!("{base}/t/{token}/live"));
        assert_eq!(code, 200);
        assert!(String::from_utf8_lossy(&body).contains("live"));
        assert!(!bump("stranger", true));
        assert!(!share_contains("stranger"));

        // Full size opens a VIEW page, not the file: it polls, so live
        // edits keep arriving even zoomed in. Unknown ids get nothing.
        let (code, body) = get(&format!("{base}/t/{token}/view/one"));
        assert_eq!(code, 200);
        let page = String::from_utf8_lossy(&body);
        assert!(page.contains("manifest.json"), "the view page polls");
        assert!(page.contains(".webp"), "and fetches the webp render");
        assert_eq!(get(&format!("{base}/t/{token}/view/stranger")).0, 404);

        stop();
    }

    #[test]
    fn a_static_gallery_is_files_and_nothing_else() {
        // The classic web-gallery gesture: no token, no server, relative
        // paths into thumbs/ and img/, ready for any host.
        let dir = tempfile::tempdir().unwrap();
        let items = vec![ServeItem { id: "one".into(), name: "One.RW2".into(), v: 0 }];
        write_gallery(dir.path(), "Family", &items).unwrap();
        let html = std::fs::read_to_string(dir.path().join("index.html")).unwrap();
        assert!(html.contains("Family"));
        assert!(html.contains("thumbs/"), "the grid uses real thumbnails");
        assert!(!html.contains("/t/"), "no token paths in a static page");
        assert!(!html.contains("setInterval"), "a static page does not poll");
        let manifest = std::fs::read_to_string(dir.path().join("manifest.json")).unwrap();
        assert!(manifest.contains("One.RW2"));
    }

    #[test]
    fn one_share_at_a_time() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let a = start("A".into(), vec![], dir.path().into(), "127.0.0.1:0", None, false).unwrap();
        let b = start("B".into(), vec![], dir.path().into(), "127.0.0.1:0", None, false).unwrap();
        assert_ne!(a.url, b.url, "each share mints its own token and port");
        assert_eq!(status().unwrap().name, "B");
        stop();
    }

    /// "Wouldn't it be kind of pain for someone who is trying
    /// to host in their home with family to always change the address?"
    /// The standing token is the other half of the stable address (the
    /// preferred port being the first): together the link repeats.
    #[test]
    fn the_address_repeats_for_the_same_home() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let t1 = persistent_token(dir.path());
        let t2 = persistent_token(dir.path());
        assert_eq!(t1, t2, "one standing token per install, not per share");
        let st = start(
            "Family".into(),
            vec![],
            dir.path().to_path_buf(),
            "127.0.0.1:0",
            Some(t1.clone()),
            false,
        )
        .unwrap();
        assert!(st.url.contains(&t1), "the share serves under the standing token");
        stop();
    }
}
