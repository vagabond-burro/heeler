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
    /// the listener's thread, joined by a stop
    listening: Option<std::thread::JoinHandle<()>>,
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

/// One answer to one request, before it is written.
struct Answer {
    status: u16,
    headers: Vec<(&'static str, String)>,
    body: Vec<u8>,
}

fn respond(status: u16, content_type: &str, body: Vec<u8>) -> Answer {
    Answer { status, headers: vec![("Content-Type", content_type.to_string())], body }
}

fn not_found() -> Answer {
    respond(404, "text/plain", b"not found".to_vec())
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        303 => "See Other",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "",
    }
}

/// A time as HTTP writes it (RFC 9110's IMF-fixdate): "Sun, 06 Nov 1994
/// 08:49:37 GMT". Worked out by hand, there being no date crate here.
fn http_date(t: std::time::SystemTime) -> String {
    let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    const WEEKDAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        WEEKDAYS[days.rem_euclid(7) as usize],
        day,
        MONTHS[(month - 1) as usize],
        year,
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

/// Writes one answer, always with `Connection: close`: a share answers
/// one request per connection and then closes it.
fn write_answer(w: &mut impl std::io::Write, answer: &Answer, head_only: bool) -> std::io::Result<()> {
    let mut out = format!("HTTP/1.1 {} {}\r\n", answer.status, reason(answer.status));
    out.push_str(&format!("Date: {}\r\n", http_date(std::time::SystemTime::now())));
    for (field, value) in &answer.headers {
        out.push_str(&format!("{field}: {value}\r\n"));
    }
    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", answer.body.len()));
    w.write_all(out.as_bytes())?;
    if !head_only {
        w.write_all(&answer.body)?;
    }
    w.flush()
}

/// Routes one request. Everything unknown is 404 with no detail: a
/// wrong token learns nothing, not even that it was a token.
///
/// `simple` drops the gate: any path outside the token prefix is
/// redirected into it, so the address a person shares is the bare
/// ip:port. "Why can't for simple home use can I just
/// have the IP and Port?" The token still anchors the internal
/// routes; it simply stops being something a guest has to know.
fn handle(url: &str, token: &str, simple: bool, name: &str, dir: &Path, shared: &Mutex<Shared>) -> Answer {
    let prefix = format!("/t/{token}");
    let Some(rest) = url.strip_prefix(&prefix) else {
        if simple {
            return Answer { status: 303, headers: vec![("Location", format!("{prefix}/"))], body: Vec::new() };
        }
        return not_found();
    };
    // Live re-fetches carry a cache-busting query; routing ignores it.
    let rest = rest.split('?').next().unwrap_or(rest);
    match rest {
        "" | "/" => {
            let html = gallery_html(name, Some(token));
            respond(200, "text/html; charset=utf-8", html.into_bytes())
        }
        "/live" | "/live/" => {
            let html = live_html(name, token);
            respond(200, "text/html; charset=utf-8", html.into_bytes())
        }
        _ if rest.starts_with("/view/") => {
            let id = urldecode(rest.trim_start_matches("/view/"));
            let known = shared
                .lock()
                .map(|s| s.items.iter().any(|i| i.id == id))
                .unwrap_or(false);
            if !known {
                return not_found();
            }
            let html = view_html(name, token, &id);
            respond(200, "text/html; charset=utf-8", html.into_bytes())
        }
        "/manifest.json" => {
            let body = match shared.lock() {
                Ok(s) => {
                    serde_json::json!({ "name": name, "items": s.items, "live": s.live }).to_string()
                }
                Err(_) => return not_found(),
            };
            respond(200, "application/json", body.into_bytes())
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
                return not_found();
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
                return not_found();
            }
            let path = dir.join(format!("{}.webp", crate::sanitize_id(&decoded)));
            match std::fs::File::open(&path) {
                Ok(mut f) => {
                    let mut buf = Vec::new();
                    if f.read_to_end(&mut buf).is_ok() {
                        respond(200, "image/webp", buf)
                    } else {
                        not_found()
                    }
                }
                Err(_) => not_found(),
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

/// The longest request head a share reads, request line and headers
/// together. A browser's GET is a few hundred bytes.
const MAX_HEAD: usize = 16 * 1024;
/// Connections served at once. A gallery page loads a few images at a
/// time; past this a new connection is told to come back.
const MAX_CONNECTIONS: usize = 64;
/// How long a connection may take to send its request, and a reader to
/// take an answer, before it is closed.
const READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// How often the listener looks at the stop flag between connections.
const ACCEPT_POLL: std::time::Duration = std::time::Duration::from_millis(25);

/// Connection threads still running, across every share: what a stop
/// must bring back to zero.
static OPEN_CONNECTIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// The connections a share has accepted and not yet finished, kept so a
/// stop can close every one of them.
///
/// This server is the share's own, not a library's. The library it
/// replaced (tiny_http) kept serving each connection it had accepted on
/// a thread of its own after its listener closed, with no way to close
/// them: requests on them went into a queue nothing answered, a browser
/// reusing one after a restart on the same port hung, and every
/// restart left a thread behind per connection a client held open.
/// Owning the sockets is what lets a stop end them.
#[derive(Default)]
struct Connections {
    next: u64,
    open: std::collections::HashMap<u64, std::net::TcpStream>,
}

/// What every connection thread of one share reads.
struct Site {
    token: String,
    simple: bool,
    name: String,
    dir: PathBuf,
    shared: Arc<Mutex<Shared>>,
}

#[derive(Debug, PartialEq)]
enum HeadError {
    /// the client went away, timed out, or the socket was closed by a stop
    Gone,
    Malformed,
    TooLarge,
}

/// Reads one request head and gives back its method and target. The
/// share serves GET and HEAD with no body, so nothing past the head is
/// read: the connection is closed after the answer.
fn read_head(r: &mut impl Read) -> Result<(String, String), HeadError> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    let end = loop {
        if let Some(at) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            break at;
        }
        if head.len() > MAX_HEAD {
            return Err(HeadError::TooLarge);
        }
        match r.read(&mut chunk) {
            Ok(0) | Err(_) => return Err(HeadError::Gone),
            Ok(n) => head.extend_from_slice(&chunk[..n]),
        }
    };
    if end > MAX_HEAD {
        return Err(HeadError::TooLarge);
    }
    let text = std::str::from_utf8(&head[..end]).map_err(|_| HeadError::Malformed)?;
    let line = text.split("\r\n").next().unwrap_or("");
    let mut parts = line.split(' ');
    match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(method), Some(target), Some(version), None)
            if !method.is_empty() && target.starts_with('/') && version.starts_with("HTTP/1.") =>
        {
            Ok((method.to_string(), target.to_string()))
        }
        _ => Err(HeadError::Malformed),
    }
}

/// Serves one connection: one request, one answer, then closed.
fn serve_connection(mut stream: std::net::TcpStream, site: &Site) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
    let (answer, head_only) = match read_head(&mut stream) {
        Ok((method, target)) if method == "GET" || method == "HEAD" => {
            (handle(&target, &site.token, site.simple, &site.name, &site.dir, &site.shared), method == "HEAD")
        }
        Ok(_) => {
            let mut a = respond(405, "text/plain", b"method not allowed".to_vec());
            a.headers.push(("Allow", "GET, HEAD".to_string()));
            (a, false)
        }
        Err(HeadError::TooLarge) => (respond(431, "text/plain", b"request too large".to_vec()), false),
        Err(HeadError::Malformed) => (respond(400, "text/plain", b"bad request".to_vec()), false),
        Err(HeadError::Gone) => return,
    };
    let _ = write_answer(&mut stream, &answer, head_only);
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// The listener's loop: accepts until the stop flag is up, registering
/// each connection before its thread starts, then closes every
/// connection still open. Nothing is accepted after the loop ends, so
/// none can slip past the close.
fn accept_loop(listener: std::net::TcpListener, stop: Arc<AtomicBool>, site: Arc<Site>) {
    let conns: Arc<Mutex<Connections>> = Arc::default();
    while !stop.load(Ordering::Relaxed) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(_) => {
                std::thread::sleep(ACCEPT_POLL);
                continue;
            }
        };
        let _ = stream.set_nonblocking(false);
        let id = {
            let mut c = conns.lock().unwrap_or_else(|e| e.into_inner());
            if c.open.len() >= MAX_CONNECTIONS {
                drop(c);
                let mut s = stream;
                let _ = s.set_write_timeout(Some(std::time::Duration::from_secs(1)));
                let _ = write_answer(&mut s, &respond(503, "text/plain", b"busy, try again".to_vec()), false);
                let _ = s.shutdown(std::net::Shutdown::Both);
                continue;
            }
            let Ok(kept) = stream.try_clone() else { continue };
            c.next += 1;
            let id = c.next;
            c.open.insert(id, kept);
            id
        };
        OPEN_CONNECTIONS.fetch_add(1, Ordering::SeqCst);
        let site = site.clone();
        let conns = conns.clone();
        std::thread::spawn(move || {
            serve_connection(stream, &site);
            conns.lock().unwrap_or_else(|e| e.into_inner()).open.remove(&id);
            OPEN_CONNECTIONS.fetch_sub(1, Ordering::SeqCst);
        });
    }
    drop(listener);
    // Close what is still open: a reader waiting on a request returns at
    // once, a writer fails, and each thread ends.
    let open: Vec<std::net::TcpStream> = conns
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .open
        .drain()
        .map(|(_, s)| s)
        .collect();
    for s in open {
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
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
    let listener = std::net::TcpListener::bind(bind).map_err(|e| e.to_string())?;
    // Polled, so the loop sees a stop within ACCEPT_POLL.
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
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
    let site = Arc::new(Site { token, simple, name, dir: dir.clone(), shared: shared.clone() });
    let flag = stop_flag.clone();
    let listening = std::thread::spawn(move || accept_loop(listener, flag, site));
    *running().lock().unwrap() =
        Some(Running { status: status.clone(), stop: stop_flag, shared, dir, listening: Some(listening) });
    Ok(status)
}

/// Stops the share: the listener closes and every connection it accepted
/// is closed, before this returns, so the port is free for the next
/// share and no request is left waiting.
pub fn stop() {
    let taken = running().lock().unwrap().take();
    if let Some(mut r) = taken {
        r.stop.store(true, Ordering::Relaxed);
        if let Some(listening) = r.listening.take() {
            let _ = listening.join();
        }
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

    /// One request on a connection the client means to keep, as a
    /// browser does: the status and the response's headers.
    fn keep_alive_get(host: &str, path: &str) -> (u16, String) {
        use std::io::Write;
        let mut s = std::net::TcpStream::connect(host).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        write!(s, "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: keep-alive\r\n\r\n").unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = s.read(&mut chunk).expect("an answer");
            assert!(n > 0, "closed before answering");
            buf.extend_from_slice(&chunk[..n]);
        }
        let text = String::from_utf8_lossy(&buf).to_string();
        let head = text.split("\r\n\r\n").next().unwrap().to_string();
        let code = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        (code, head)
    }

    /// A stopped and restarted share answers the first load. Every
    /// answer says Connection: close, so the browser holds no idle
    /// connection to the stopped server for the restarted one's first
    /// load to go down and hang on.
    #[test]
    fn every_answer_closes_the_connection() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("one.webp"), b"fake webp bytes").unwrap();
        let items = vec![ServeItem { id: "one".into(), name: "One.RW2".into(), v: 0 }];
        let st = start("Home".into(), items, dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
        let port = st.url.split(':').nth(2).unwrap().trim_end_matches('/');
        let host = format!("127.0.0.1:{port}");
        let (_, redirect) = keep_alive_get(&host, "/");
        let into = redirect
            .lines()
            .find_map(|l| l.strip_prefix("Location: "))
            .unwrap()
            .trim_end_matches('/')
            .to_string();
        for (path, code) in [
            ("/".to_string(), 303),
            (format!("{into}/"), 200),
            (format!("{into}/live"), 200),
            (format!("{into}/view/one"), 200),
            (format!("{into}/manifest.json"), 200),
            (format!("{into}/img/one.webp"), 200),
            (format!("{into}/img/nobody.webp"), 404),
        ] {
            let (got, head) = keep_alive_get(&host, &path);
            assert_eq!(got, code, "{path}");
            assert!(
                head.lines().any(|l| l.eq_ignore_ascii_case("Connection: close")),
                "{path} must close: {head}"
            );
        }
        stop();
    }

    /// What the tutorial kept doing: stop, start again on the same port,
    /// load. A client that honors Connection: close, as browsers do,
    /// opens a fresh connection and the new share answers it.
    #[test]
    fn a_restart_on_the_same_port_answers_the_first_load() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let items = || vec![ServeItem { id: "one".into(), name: "One.RW2".into(), v: 0 }];
        let st = start("Home".into(), items(), dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
        let port = st.url.split(':').nth(2).unwrap().trim_end_matches('/').to_string();
        let host = format!("127.0.0.1:{port}");
        for _ in 0..6 {
            let (code, head) = keep_alive_get(&host, "/");
            assert_eq!(code, 303);
            assert!(head.lines().any(|l| l.eq_ignore_ascii_case("Connection: close")));
            stop();
            // The old loop lets go of the port within one receive wait.
            std::thread::sleep(std::time::Duration::from_millis(400));
            start("Home".into(), items(), dir.path().to_path_buf(), &host, None, true)
                .expect("the same port again");
        }
        assert_eq!(keep_alive_get(&host, "/").0, 303);
        stop();
    }

    /// A client holding a connection open mid-request, as a slow client
    /// or a browser's preconnect does: part of a head sent, the rest
    /// never. Returns once the server has the connection on a thread.
    fn idle_client(host: &str) -> std::net::TcpStream {
        use std::io::Write;
        let before = OPEN_CONNECTIONS.load(Ordering::SeqCst);
        let mut s = std::net::TcpStream::connect(host).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_millis(1500))).unwrap();
        write!(s, "GET / HTTP/1.1\r\nHost: {host}\r\n").unwrap();
        let since = std::time::Instant::now();
        while OPEN_CONNECTIONS.load(Ordering::SeqCst) <= before && since.elapsed() < std::time::Duration::from_secs(3) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        s
    }

    /// Whether the server has closed this connection: a read ends (EOF
    /// or reset) instead of timing out.
    fn closed_by_server(s: &mut std::net::TcpStream) -> bool {
        let mut b = [0u8; 256];
        loop {
            match s.read(&mut b) {
                Ok(0) => return true,
                Ok(_) => continue,
                Err(e) => {
                    return !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
                }
            }
        }
    }

    fn wait_for_no_connections() -> usize {
        let since = std::time::Instant::now();
        while OPEN_CONNECTIONS.load(Ordering::SeqCst) > 0 && since.elapsed() < std::time::Duration::from_secs(3) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        OPEN_CONNECTIONS.load(Ordering::SeqCst)
    }

    /// From the independent review: clients holding their connections
    /// through fifty stops left every socket open and a thread behind for
    /// each. A stop now closes them all, mid-request too, and their
    /// threads end.
    #[test]
    fn stopping_closes_every_connection_it_accepted() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let mut clients = Vec::new();
        for _ in 0..50 {
            let st = start("Home".into(), vec![], dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
            let host = format!("127.0.0.1:{}", st.url.split(':').nth(2).unwrap().trim_end_matches('/'));
            clients.push(idle_client(&host));
            stop();
        }
        let still_open = clients.iter_mut().map(closed_by_server).filter(|closed| !closed).count();
        assert_eq!(still_open, 0, "every connection is closed by the stop");
        assert_eq!(wait_for_no_connections(), 0, "and every connection thread has ended");
    }

    /// A request finished on a connection from before a stop is not left
    /// hanging: the connection is already closed.
    #[test]
    fn a_request_after_a_stop_is_refused_not_hung() {
        use std::io::Write;
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let st = start("Home".into(), vec![], dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
        let host = format!("127.0.0.1:{}", st.url.split(':').nth(2).unwrap().trim_end_matches('/'));
        let mut s = idle_client(&host);
        stop();
        let _ = write!(s, "\r\n");
        // Closed with nothing said: a stopped share answers nobody, and
        // leaves nobody waiting.
        let mut got = Vec::new();
        let ended = loop {
            let mut b = [0u8; 256];
            match s.read(&mut b) {
                Ok(0) => break true,
                Ok(n) => got.extend_from_slice(&b[..n]),
                Err(e) => break !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut),
            }
        };
        assert!(ended, "the late request meets a closed connection");
        assert!(got.is_empty(), "and no answer: {}", String::from_utf8_lossy(&got));
    }

    /// One request per connection: a second request pipelined behind the
    /// first is not answered, since the first answer said close and the
    /// connection then closes.
    #[test]
    fn a_connection_carries_one_request() {
        use std::io::Write;
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let st = start("Home".into(), vec![], dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
        let host = format!("127.0.0.1:{}", st.url.split(':').nth(2).unwrap().trim_end_matches('/'));
        let mut s = std::net::TcpStream::connect(&host).unwrap();
        s.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        write!(s, "GET / HTTP/1.1\r\nHost: {host}\r\n\r\nGET / HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut all = Vec::new();
        let _ = s.read_to_end(&mut all);
        let text = String::from_utf8_lossy(&all);
        assert_eq!(text.matches("HTTP/1.1 303").count(), 1, "{text}");
        stop();
    }

    /// Every answer carries the Date HTTP asks for, Content-Length, and
    /// Connection: close; HEAD gets the headers and no body.
    #[test]
    fn answers_carry_date_and_length_and_head_has_no_body() {
        use std::io::Write;
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let st = start("Home".into(), vec![], dir.path().to_path_buf(), "127.0.0.1:0", None, false).unwrap();
        let addr = st.url.strip_prefix("http://").unwrap();
        let (host, path) = addr.split_once('/').unwrap();
        let host = format!("127.0.0.1:{}", host.split(':').nth(1).unwrap());
        for method in ["GET", "HEAD"] {
            let mut s = std::net::TcpStream::connect(&host).unwrap();
            s.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            write!(s, "{method} /{path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
            let mut all = Vec::new();
            s.read_to_end(&mut all).unwrap();
            let text = String::from_utf8_lossy(&all).to_string();
            let (head, body) = text.split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with("HTTP/1.1 200 OK"), "{head}");
            let date = head.lines().find_map(|l| l.strip_prefix("Date: ")).expect("a Date header");
            assert!(date.ends_with(" GMT") && date.len() == 29, "{date}");
            let length: usize = head.lines().find_map(|l| l.strip_prefix("Content-Length: ")).unwrap().parse().unwrap();
            assert!(head.lines().any(|l| l == "Connection: close"));
            if method == "GET" {
                assert_eq!(body.len(), length);
                assert!(length > 0);
            } else {
                assert!(body.is_empty(), "HEAD has no body");
            }
        }
        stop();
    }

    /// RFC 9110's own example date, and the turn of a leap day.
    #[test]
    fn http_dates_are_written_as_http_asks() {
        let at = |s: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(s);
        assert_eq!(http_date(at(784_111_777)), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(http_date(at(0)), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(at(951_782_400)), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(http_date(at(1_790_000_000)), "Mon, 21 Sep 2026 14:13:20 GMT");
    }

    /// What is not a GET or HEAD, a head too large, and a line that is
    /// not HTTP each get their own answer, and the connection closes.
    #[test]
    fn requests_it_does_not_serve_get_an_answer_that_says_so() {
        use std::io::Write;
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let st = start("Home".into(), vec![], dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
        let host = format!("127.0.0.1:{}", st.url.split(':').nth(2).unwrap().trim_end_matches('/'));
        let ask = |raw: Vec<u8>| -> String {
            let mut s = std::net::TcpStream::connect(&host).unwrap();
            s.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
            let _ = s.write_all(&raw);
            let mut all = Vec::new();
            let _ = s.read_to_end(&mut all);
            String::from_utf8_lossy(&all).lines().next().unwrap_or("").to_string()
        };
        assert_eq!(ask(b"POST / HTTP/1.1\r\nHost: x\r\n\r\n".to_vec()), "HTTP/1.1 405 Method Not Allowed");
        let mut big = b"GET / HTTP/1.1\r\nX: ".to_vec();
        big.extend(std::iter::repeat(b'a').take(20_000));
        big.extend_from_slice(b"\r\n\r\n");
        assert_eq!(ask(big), "HTTP/1.1 431 Request Header Fields Too Large");
        assert_eq!(ask(b"hello there\r\n\r\n".to_vec()), "HTTP/1.1 400 Bad Request");
        stop();
    }

    /// Past MAX_CONNECTIONS a new connection is told to come back rather
    /// than given a thread; the stop still closes the ones it kept.
    #[test]
    fn connections_past_the_limit_are_told_to_come_back() {
        let _one_at_a_time = serial();
        let dir = tempfile::tempdir().unwrap();
        let st = start("Home".into(), vec![], dir.path().to_path_buf(), "127.0.0.1:0", None, true).unwrap();
        let host = format!("127.0.0.1:{}", st.url.split(':').nth(2).unwrap().trim_end_matches('/'));
        // Silent clients: each holds a connection thread waiting on a head.
        let silent: Vec<std::net::TcpStream> =
            (0..MAX_CONNECTIONS).map(|_| std::net::TcpStream::connect(&host).unwrap()).collect();
        let since = std::time::Instant::now();
        while OPEN_CONNECTIONS.load(Ordering::SeqCst) < MAX_CONNECTIONS && since.elapsed() < std::time::Duration::from_secs(3) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let mut late = std::net::TcpStream::connect(&host).unwrap();
        late.set_read_timeout(Some(std::time::Duration::from_secs(3))).unwrap();
        let mut all = Vec::new();
        let _ = late.read_to_end(&mut all);
        assert!(String::from_utf8_lossy(&all).starts_with("HTTP/1.1 503"), "{}", String::from_utf8_lossy(&all));
        stop();
        drop(silent);
        assert_eq!(wait_for_no_connections(), 0);
    }

    #[test]
    fn a_request_head_is_read_to_its_end_and_no_further() {
        let mut r: &[u8] = b"GET /t/x/img/a.webp?v=2 HTTP/1.1\r\nHost: h\r\n\r\nleftover";
        assert_eq!(read_head(&mut r), Ok(("GET".into(), "/t/x/img/a.webp?v=2".into())));
        let mut cut: &[u8] = b"GET / HTTP/1.1\r\nHost: h\r\n";
        assert_eq!(read_head(&mut cut), Err(HeadError::Gone));
        let mut odd: &[u8] = b"GET http://elsewhere/ HTTP/1.1\r\n\r\n";
        assert_eq!(read_head(&mut odd), Err(HeadError::Malformed));
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
