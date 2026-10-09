//! Bounded HTTP ingress, separate from the serial command dispatcher. Only
//! complete authenticated JSON requests reach application code.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, BufReader, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver, RecvTimeoutError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

pub const BODY_LIMIT: usize = 8 * 1024 * 1024;
pub const HEADER_LIMIT: usize = 16 * 1024;
pub const READ_DEADLINE: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(50);
/// How long a refused request's connection stays open to swallow what
/// its client is still sending (see `linger`).
const LINGER: Duration = Duration::from_millis(500);
const CONNECTIONS: usize = 16;

type Reply = (u16, Value);
type Handler = dyn Fn(&str, Value, &AtomicBool) -> Result<Value, String> + Send + Sync;
struct Job {
    method: String,
    params: Value,
    answer: std::sync::mpsc::SyncSender<Reply>,
}
#[derive(Clone, Copy)]
struct Limits {
    body: usize,
    headers: usize,
    read: Duration,
    write: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            body: BODY_LIMIT,
            headers: HEADER_LIMIT,
            read: READ_DEADLINE,
            write: READ_DEADLINE,
        }
    }
}
type Sockets = Arc<Mutex<HashMap<u64, TcpStream>>>;
pub struct Transport {
    pub port: u16,
    pub stop: Arc<AtomicBool>,
    sockets: Sockets,
    accept: Option<JoinHandle<()>>,
}
impl Transport {
    pub fn start(token: String, handler: Arc<Handler>) -> Result<Self, String> {
        Self::with_limits(token, handler, Limits::default())
    }
    fn with_limits(token: String, handler: Arc<Handler>, limits: Limits) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let sockets: Sockets = Default::default();
        let (jobs, rx) = sync_channel::<Job>(CONNECTIONS);
        let flag = stop.clone();
        thread::Builder::new()
            .name("heeler-api-dispatch".into())
            .spawn(move || {
                while !flag.load(Ordering::Acquire) {
                    let job = match rx.recv_timeout(POLL) {
                        Ok(job) => job,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(_) => break,
                    };
                    if flag.load(Ordering::Acquire) {
                        break;
                    }
                    let reply = match handler(&job.method, job.params, &flag) {
                        Ok(data) => (200, json!({"ok":true,"data":data})),
                        Err(error) => failure(200, error),
                    };
                    let _ = job.answer.try_send(reply);
                }
            })
            .map_err(|e| e.to_string())?;
        let flag = stop.clone();
        let clients = sockets.clone();
        let accept = thread::Builder::new()
            .name("heeler-api-accept".into())
            .spawn(move || {
                static NEXT: AtomicU64 = AtomicU64::new(1);
                while !flag.load(Ordering::Acquire) {
                    let (stream, _) = match listener.accept() {
                        Ok(pair) => pair,
                        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                            // The listener is polled rather than nudged shut,
                            // so Stop never needs a connection of its own; at
                            // the shared poll interval an idle door costs
                            // twenty wakes a second, not two hundred, and a
                            // script waits at most that long to be admitted.
                            thread::sleep(POLL);
                            continue;
                        }
                        Err(_) => break,
                    };
                    // Refuse excess connections immediately, without doing socket IO
                    // on the accept thread. Existing stalls cannot grow thread count.
                    let mut held = clients.lock().unwrap();
                    if held.len() >= CONNECTIONS || flag.load(Ordering::Acquire) {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    let id = NEXT.fetch_add(1, Ordering::Relaxed);
                    let Ok(control) = stream.try_clone() else {
                        continue;
                    };
                    held.insert(id, control);
                    drop(held);
                    let guard = Client {
                        id,
                        sockets: clients.clone(),
                    };
                    let token = token.clone();
                    let flag = flag.clone();
                    let jobs = jobs.clone();
                    let accepted = Instant::now();
                    let _ = thread::Builder::new()
                        .name("heeler-api-client".into())
                        .spawn(move || {
                            let _guard = guard;
                            let _ = stream.set_read_timeout(Some(POLL));
                            let _ = stream.set_write_timeout(Some(POLL));
                            let mut reader = BufReader::new(SocketRead {
                                stream,
                                stop: flag.clone(),
                                deadline: accepted + limits.read,
                            });
                            let asked = request(&mut reader, &token, limits);
                            // A refusal answers a request that was not
                            // read to its end: its client may still be
                            // sending.
                            let refused = asked.is_err();
                            let reply = match asked {
                                Ok((method, params)) if !flag.load(Ordering::Acquire) => {
                                    let (answer, result) = sync_channel(1);
                                    if jobs
                                        .try_send(Job {
                                            method,
                                            params,
                                            answer,
                                        })
                                        .is_err()
                                    {
                                        failure(503, "API dispatcher is busy")
                                    } else {
                                        wait_reply(result, &flag)
                                    }
                                }
                                Ok(_) => failure(503, "API stopped"),
                                Err(reply) => reply,
                            };
                            let mut stream = reader.into_inner().stream;
                            let sent = respond(&mut stream, reply, &flag, limits.write);
                            if refused && sent.is_ok() {
                                linger(stream, flag);
                            } else {
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                        });
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            port,
            stop,
            sockets,
            accept: Some(accept),
        })
    }
    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Close all sockets, including partial headers, body reads and replies
        // whose client stopped reading. Stop never waits for a render to finish.
        for socket in self.sockets.lock().unwrap().values() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
        // Cover an accept that raced the first socket snapshot.
        for socket in self.sockets.lock().unwrap().values() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        self.shutdown();
    }
}
struct Client {
    id: u64,
    sockets: Sockets,
}
impl Drop for Client {
    fn drop(&mut self) {
        self.sockets.lock().unwrap().remove(&self.id);
    }
}
struct SocketRead {
    stream: TcpStream,
    stop: Arc<AtomicBool>,
    deadline: Instant,
}
impl Read for SocketRead {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.stop.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "API stopped",
                ));
            }
            if Instant::now() >= self.deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "request read deadline exceeded",
                ));
            }
            match self.stream.read(bytes) {
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
    }
}
/// Closes a refused request's connection without losing its reply.
///
/// A refusal (a 408 at the deadline, a 413 before the upload, a bad
/// token) goes out while the client may still be sending, and a close
/// then is a reset: bytes that land on a closed socket, or sit unread
/// in it at the close, answer with one, and a reset discards the reply
/// the client has not read yet. The script saw "connection reset by
/// peer" where the API had said what was wrong. So the sending half
/// closes first, which ends the reply, and what the client still sends
/// is read and dropped until it closes its end, Stop is asked, or
/// LINGER runs out; a client that never stops sending holds its slot
/// that much longer and no more.
fn linger(stream: TcpStream, stop: Arc<AtomicBool>) {
    let _ = stream.shutdown(Shutdown::Write);
    let mut rest = SocketRead {
        stream,
        stop,
        deadline: Instant::now() + LINGER,
    };
    let mut dropped = [0u8; 4096];
    while matches!(rest.read(&mut dropped), Ok(n) if n > 0) {}
    let _ = rest.stream.shutdown(Shutdown::Both);
}
fn failure(code: u16, error: impl Into<String>) -> Reply {
    (code, json!({"ok":false,"error":error.into()}))
}
fn read_error(e: io::Error) -> Reply {
    failure(
        if e.kind() == io::ErrorKind::TimedOut {
            408
        } else {
            400
        },
        format!("cannot read request: {e}"),
    )
}
fn line(reader: &mut impl BufRead, remaining: &mut usize) -> Result<String, Reply> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(read_error)?;
        if buffer.is_empty() {
            return Err(failure(400, "truncated HTTP request"));
        }
        let n = buffer
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buffer.len());
        if n > *remaining {
            return Err(failure(
                431,
                "HTTP headers or chunk framing exceed 16384 bytes",
            ));
        }
        bytes.extend_from_slice(&buffer[..n]);
        reader.consume(n);
        *remaining -= n;
        if bytes.ends_with(b"\n") {
            break;
        }
    }
    if !bytes.ends_with(b"\r\n") {
        return Err(failure(400, "HTTP lines require CRLF"));
    }
    bytes.truncate(bytes.len() - 2);
    String::from_utf8(bytes).map_err(|_| failure(400, "invalid HTTP header encoding"))
}
fn request(
    reader: &mut impl BufRead,
    token: &str,
    limits: Limits,
) -> Result<(String, Value), Reply> {
    let mut budget = limits.headers;
    let first = line(reader, &mut budget)?;
    let parts: Vec<_> = first.split_whitespace().collect();
    if parts.len() != 3 || !matches!(parts[2], "HTTP/1.0" | "HTTP/1.1") {
        return Err(failure(400, "invalid HTTP request line"));
    }
    if parts[0] != "POST" {
        return Err(failure(405, "use POST for API requests"));
    }
    let mut auth = None;
    let mut length = None;
    let mut chunked = false;
    let mut encoding = false;
    let mut expect = false;
    loop {
        let header = line(reader, &mut budget)?;
        if header.is_empty() {
            break;
        }
        let (name, value) = header
            .split_once(':')
            .ok_or_else(|| failure(400, "malformed HTTP header"))?;
        let value = value.trim();
        match name.to_ascii_lowercase().as_str() {
            "x-heeler-token" => {
                if auth.replace(value.to_string()).is_some() {
                    return Err(failure(403, "bad token"));
                }
            }
            "content-length" => {
                if length.is_some()
                    || value.is_empty()
                    || !value.bytes().all(|b| b.is_ascii_digit())
                {
                    return Err(failure(400, "invalid Content-Length"));
                }
                length = Some(
                    value
                        .parse::<usize>()
                        .map_err(|_| failure(413, "request body exceeds 8388608 bytes"))?,
                );
            }
            "transfer-encoding" => {
                if encoding || !value.eq_ignore_ascii_case("chunked") {
                    return Err(failure(400, "unsupported Transfer-Encoding"));
                }
                encoding = true;
                chunked = true;
            }
            "expect" => expect = true,
            _ => {}
        }
    }
    if auth.as_deref() != Some(token) {
        return Err(failure(403, "bad token"));
    }
    if chunked && length.is_some() {
        return Err(failure(
            400,
            "Content-Length and Transfer-Encoding cannot be combined",
        ));
    }
    if length.is_some_and(|n| n > limits.body) {
        return Err(failure(413, "request body exceeds 8388608 bytes"));
    }
    // This local protocol sends bodies immediately, without 100-continue.
    if expect {
        return Err(failure(
            417,
            "Expect is not supported; send the body directly",
        ));
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let size = line(reader, &mut budget)?;
            let hex = size.split(';').next().unwrap_or("");
            if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(failure(400, "invalid chunk size"));
            }
            let size = usize::from_str_radix(hex, 16)
                .map_err(|_| failure(413, "request body exceeds 8388608 bytes"))?;
            if size > limits.body - body.len() {
                return Err(failure(413, "request body exceeds 8388608 bytes"));
            }
            if size == 0 {
                loop {
                    let trailer = line(reader, &mut budget)?;
                    if trailer.is_empty() {
                        break;
                    }
                    if !trailer.contains(':') {
                        return Err(failure(400, "invalid chunk trailer"));
                    }
                }
                break;
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..]).map_err(read_error)?;
            let mut ending = [0; 2];
            reader.read_exact(&mut ending).map_err(read_error)?;
            if ending != *b"\r\n" {
                return Err(failure(400, "invalid chunk ending"));
            }
        }
    } else {
        let size =
            length.ok_or_else(|| failure(411, "Content-Length or chunked encoding is required"))?;
        body.resize(size, 0);
        reader.read_exact(&mut body).map_err(read_error)?;
    }
    let parsed: Value =
        serde_json::from_slice(&body).map_err(|e| failure(400, format!("malformed JSON: {e}")))?;
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty())
        .ok_or_else(|| failure(400, "JSON request needs a nonempty method string"))?;
    Ok((
        method.to_string(),
        parsed.get("params").cloned().unwrap_or(Value::Null),
    ))
}
fn wait_reply(rx: Receiver<Reply>, stop: &AtomicBool) -> Reply {
    loop {
        if stop.load(Ordering::Acquire) {
            return failure(503, "API stopped");
        }
        match rx.recv_timeout(POLL) {
            Ok(reply) => return reply,
            Err(RecvTimeoutError::Timeout) => {}
            Err(_) => return failure(503, "API dispatcher stopped"),
        }
    }
}
fn respond(
    stream: &mut TcpStream,
    (code, value): Reply,
    stop: &AtomicBool,
    duration: Duration,
) -> io::Result<()> {
    let body = value.to_string();
    let reason = match code {
        200 => "OK",
        400 => "Bad Request",
        403 => "Forbidden",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        411 => "Length Required",
        413 => "Content Too Large",
        417 => "Expectation Failed",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    let header = format!("HTTP/1.1 {code} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
    let deadline = Instant::now() + duration;
    for data in [header.as_bytes(), body.as_bytes()] {
        let mut remaining = data;
        while !remaining.is_empty() {
            if stop.load(Ordering::Acquire) || Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "reply deadline exceeded",
                ));
            }
            match stream.write(remaining) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(n) => remaining = &remaining[n..],
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(e) => return Err(e),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    fn wire(body: &[u8]) -> Vec<u8> {
        let mut request = format!("POST / HTTP/1.1\r\nHost: localhost\r\nX-Heeler-Token: secret\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        request.extend_from_slice(body);
        request
    }
    fn parse(bytes: &[u8]) -> Result<(String, Value), Reply> {
        request(&mut io::Cursor::new(bytes), "secret", Limits::default())
    }
    fn connect(server: &Transport) -> TcpStream {
        let stream = TcpStream::connect(("127.0.0.1", server.port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        stream
    }
    fn response(mut stream: TcpStream) -> (u16, Value) {
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        let text = String::from_utf8(bytes).unwrap();
        let (head, body) = text.split_once("\r\n\r\n").expect("complete response");
        assert!(head.contains("Content-Type: application/json"));
        assert!(head.contains("Connection: close"));
        (
            head.split_whitespace().nth(1).unwrap().parse().unwrap(),
            serde_json::from_str(body).unwrap(),
        )
    }
    fn ping(server: &Transport) -> (u16, Value) {
        let mut stream = connect(server);
        stream
            .write_all(&wire(br#"{"method":"app.ping"}"#))
            .unwrap();
        response(stream)
    }
    fn server(limits: Limits) -> (Transport, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        (
            Transport::with_limits(
                "secret".into(),
                Arc::new(move |method, params, _| {
                    count.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"method":method,"params":params}))
                }),
                limits,
            )
            .unwrap(),
            calls,
        )
    }
    #[test]
    fn post_json_and_chunked_json_keep_the_existing_method_and_params_contract() {
        let body = br#"{"method":"graph.command","params":{"command":{"type":"undo"}}}"#;
        let expected = parse(&wire(body)).unwrap();
        let chunks = format!("POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n{:x};example=yes\r\n{}\r\n0\r\nNote: ignored\r\n\r\n", body.len(), std::str::from_utf8(body).unwrap());
        assert_eq!(parse(chunks.as_bytes()).unwrap(), expected);
    }
    #[test]
    fn advertised_oversize_is_rejected_before_reading_the_body() {
        let text = format!(
            "POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: {}\r\n\r\n",
            BODY_LIMIT + 1
        );
        assert_eq!(parse(text.as_bytes()).unwrap_err().0, 413);
    }
    #[test]
    fn chunked_limit_counts_all_decoded_chunks() {
        let limits = Limits {
            body: 8,
            ..Limits::default()
        };
        let text = b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n1234\r\n5\r\n";
        assert_eq!(
            request(&mut io::Cursor::new(text), "secret", limits)
                .unwrap_err()
                .0,
            413
        );
    }
    #[test]
    fn exact_body_limit_is_accepted() {
        let base = br#"{"method":"app.ping","params":""}"#;
        let body = format!(
            "{{\"method\":\"app.ping\",\"params\":\"{}\"}}",
            "a".repeat(BODY_LIMIT - base.len())
        );
        assert_eq!(body.len(), BODY_LIMIT);
        assert!(parse(&wire(body.as_bytes())).is_ok());
    }
    #[test]
    fn invalid_json_has_an_explicit_error_without_dispatch() {
        for body in [
            b"{".as_slice(),
            b"",
            b"\xff",
            b"{\"method\":\"x\"} trailing",
        ] {
            let (status, error) = parse(&wire(body)).unwrap_err();
            assert_eq!(status, 400);
            assert!(error["error"]
                .as_str()
                .unwrap()
                .starts_with("malformed JSON:"));
        }
    }
    #[test]
    fn invalid_envelopes_never_become_an_empty_method() {
        for body in ["null", "[]", "{}", "{\"method\":2}", "{\"method\":\"\"}"] {
            let (status, error) = parse(&wire(body.as_bytes())).unwrap_err();
            assert_eq!(status, 400);
            assert!(error["error"].as_str().unwrap().contains("method"));
        }
    }
    #[test]
    fn truncated_fixed_and_chunked_bodies_are_errors() {
        for bytes in [b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 10\r\n\r\n{}".as_slice(), b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{}", b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n"] {
            assert_eq!(parse(bytes).unwrap_err().0, 400);
        }
    }
    #[test]
    fn ambiguous_framing_and_bad_chunk_syntax_are_refused() {
        for headers in [
            "Content-Length: 1\r\nContent-Length: 1",
            "Content-Length: 1\r\nTransfer-Encoding: chunked",
            "Content-Length: -1",
            "Content-Length:",
            "Transfer-Encoding: gzip",
            "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked",
        ] {
            let text =
                format!("POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\n{headers}\r\n\r\n0\r\n\r\n");
            assert_eq!(parse(text.as_bytes()).unwrap_err().0, 400);
        }
        for chunks in ["xyz\r\n", "1\r\naXX", "0\r\ninvalid-trailer\r\n\r\n"] {
            let text = format!("POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n{chunks}");
            assert_eq!(parse(text.as_bytes()).unwrap_err().0, 400);
        }
    }
    #[test]
    fn headers_and_chunk_metadata_share_a_bounded_budget() {
        let text = format!("POST / HTTP/1.1\r\nX-Padding: {}", "a".repeat(HEADER_LIMIT));
        assert_eq!(parse(text.as_bytes()).unwrap_err().0, 431);
        let text = format!(
            "POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n1;{}",
            "a".repeat(HEADER_LIMIT)
        );
        assert_eq!(parse(text.as_bytes()).unwrap_err().0, 431);
    }
    #[test]
    fn token_is_required_and_duplicate_tokens_are_not_accepted() {
        for token in [
            "X-Heeler-Token: wrong",
            "X-Heeler-Token: secret\r\nX-Heeler-Token: secret",
            "X-Unrelated: secret",
        ] {
            let text = format!("POST / HTTP/1.1\r\n{token}\r\nContent-Length: 0\r\n\r\n");
            assert_eq!(parse(text.as_bytes()).unwrap_err().0, 403);
        }
    }
    #[test]
    fn unsupported_http_requests_get_named_errors() {
        for (request, code) in [("GET / HTTP/1.1\r\n\r\n",405), ("not-http\r\n",400), ("POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\n\r\n",411), ("POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 1\r\nExpect: 100-continue\r\n\r\n",417)] {
            assert_eq!(parse(request.as_bytes()).unwrap_err().0, code);
        }
    }
    #[test]
    fn real_socket_accepts_chunks_and_refuses_oversize_before_upload() {
        let (server, calls) = server(Limits::default());
        let mut chunks = connect(&server);
        chunks.write_all(b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\na\r\n{\"method\":\r\nb\r\n\"app.ping\"}\r\n0\r\n\r\n").unwrap();
        assert_eq!(response(chunks).0, 200);
        let mut large = connect(&server);
        large
            .write_all(
                format!(
                    "POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: {}\r\n\r\n",
                    BODY_LIMIT + 1
                )
                .as_bytes(),
            )
            .unwrap();
        assert_eq!(response(large).0, 413);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn real_socket_rejects_invalid_json_without_calling_the_dispatcher() {
        let (server, calls) = server(Limits::default());
        let mut stream = connect(&server);
        stream.write_all(&wire(b"{")).unwrap();
        assert_eq!(response(stream).0, 400);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(ping(&server).0, 200);
    }
    #[test]
    fn stalled_headers_and_bodies_do_not_block_another_client() {
        let (server, calls) = server(Limits::default());
        let mut headers = connect(&server);
        headers.write_all(b"POST / HTTP/1.1\r\nX-Heeler").unwrap();
        let mut body = connect(&server);
        body.write_all(b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 10\r\n\r\n{")
            .unwrap();
        assert_eq!(ping(&server).0, 200);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn absolute_deadline_applies_to_headers_fixed_bodies_and_chunks() {
        for prefix in [b"POST / HTTP/1.1\r\n".as_slice(), b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 10\r\n\r\n{", b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{"] {
            let (server, calls) = server(Limits { read: Duration::from_millis(100), ..Limits::default() });
            let mut stream = connect(&server); stream.write_all(prefix).unwrap(); let reply = response(stream);
            assert_eq!(reply.0,408); assert_eq!(calls.load(Ordering::SeqCst),0);
        }
    }
    #[test]
    fn drip_feeding_does_not_extend_the_absolute_deadline() {
        let (server, _) = server(Limits {
            read: Duration::from_millis(100),
            ..Limits::default()
        });
        let stream = connect(&server);
        let mut writer = stream.try_clone().unwrap();
        let drip = thread::spawn(move || {
            for _ in 0..10 {
                if writer.write_all(b"a").is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(25));
            }
        });
        assert_eq!(response(stream).0, 408);
        drip.join().unwrap();
    }
    #[test]
    fn a_refusal_reaches_a_client_that_is_still_sending() {
        // The refusal used to be followed by a close with the client's
        // next bytes still on their way: bytes landing on a closed
        // socket answer with a reset, and a reset takes the unread
        // reply with it. The script saw "connection reset by peer"
        // where the API had said 408 (and the drip test above failed
        // one run in many, 2026-10-03). The connection now stays open
        // a moment to swallow what is still coming.
        let (server, _) = server(Limits {
            read: Duration::from_millis(100),
            ..Limits::default()
        });
        let mut stream = connect(&server);
        stream.write_all(b"POST / HTTP/1.1\r\n").unwrap();
        // Wait for the refusal to arrive, without reading it.
        let mut first = [0u8; 1];
        assert_eq!(stream.peek(&mut first).unwrap(), 1);
        // Keep sending, as a client mid-upload would, and give a reset
        // the time to come back.
        stream.write_all(&[b'a'; 4096]).unwrap();
        thread::sleep(Duration::from_millis(100));
        assert_eq!(response(stream).0, 408);
    }
    #[test]
    fn sixteen_refused_clients_that_never_close_release_the_connection_limit() {
        let (server, called) = server(Limits::default());
        let mut clients = Vec::new();
        for _ in 0..CONNECTIONS {
            let mut stream = connect(&server);
            stream.write_all(b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 999999999\r\n\r\n").unwrap();
            clients.push(stream);
        }
        for stream in &clients {
            assert_eq!(stream.peek(&mut [0]).unwrap(), 1);
        }
        assert_eq!(server.sockets.lock().unwrap().len(), CONNECTIONS);
        let extra = connect(&server);
        assert!(matches!(extra.peek(&mut [0]), Ok(0) | Err(_)));
        // None of these clients closes its sending half. The absolute
        // linger deadline must still free every slot.
        let until = Instant::now() + Duration::from_secs(2);
        while !server.sockets.lock().unwrap().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(server.sockets.lock().unwrap().is_empty());
        for stream in clients { assert_eq!(response(stream).0, 413); }
        assert_eq!(called.load(Ordering::Acquire), 0);
        assert_eq!(ping(&server).0, 200);
    }

    #[test]
    fn stop_interrupts_refusal_linger_without_waiting_for_the_client() {
        let (mut server, _) = server(Limits::default());
        let mut stream = connect(&server);
        stream.write_all(b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 999999999\r\n\r\n").unwrap();
        assert_eq!(stream.peek(&mut [0]).unwrap(), 1);
        assert_eq!(server.sockets.lock().unwrap().len(), 1);
        let t = Instant::now();
        server.shutdown();
        let until = Instant::now() + Duration::from_millis(200);
        while !server.sockets.lock().unwrap().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(server.sockets.lock().unwrap().is_empty());
        assert!(t.elapsed() < Duration::from_millis(250));
    }

    #[test]
    fn client_eof_before_declared_length_is_a_400() {
        let (server, _) = server(Limits::default());
        let mut stream = connect(&server);
        stream
            .write_all(
                b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 100\r\n\r\n{}",
            )
            .unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        assert_eq!(response(stream).0, 400);
    }
    #[test]
    fn a_client_that_never_reads_its_large_reply_does_not_hold_the_dispatcher() {
        let (entered, entry) = sync_channel(1);
        let server = Transport::with_limits(
            "secret".into(),
            Arc::new(move |method, _, _| {
                if method == "large" {
                    let reply = json!("a".repeat(8 * 1024 * 1024));
                    entered.try_send(()).unwrap();
                    Ok(reply)
                } else {
                    Ok(json!(true))
                }
            }),
            Limits {
                write: Duration::from_millis(100),
                ..Limits::default()
            },
        )
        .unwrap();
        let mut slow = connect(&server);
        slow.write_all(&wire(br#"{"method":"large"}"#)).unwrap();
        entry.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(ping(&server), (200, json!({"ok":true,"data":true})));
    }
    #[test]
    fn stop_closes_partial_requests_and_the_listener_without_a_nudge_request() {
        let (mut server, _) = server(Limits::default());
        let mut stream = connect(&server);
        stream.write_all(b"POST ").unwrap();
        server.shutdown();
        let mut buf = [0; 1];
        assert!(matches!(stream.read(&mut buf), Ok(0) | Err(_)));
        // The listener lives in the accept thread and closes when that
        // thread ends, so the join is the proof. The port itself is not
        // probed: once freed it is the system's to hand out, and another
        // test's server in this process can be given it (a connect there
        // succeeded once in about a hundred loaded runs, 2026-10-03).
        assert!(server.accept.is_none(), "the accept thread, and the listener it owns, are gone");
        server.shutdown();
    }
    #[test]
    fn stop_cancels_a_running_wait_and_never_dispatches_queued_commands() {
        let (entered, entry) = sync_channel(1);
        let (finished, finish) = sync_channel(1);
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut server = Transport::start(
            "secret".into(),
            Arc::new(move |_, _, stop| {
                count.fetch_add(1, Ordering::SeqCst);
                let _ = entered.try_send(());
                while !stop.load(Ordering::Acquire) {
                    thread::sleep(Duration::from_millis(5));
                }
                let _ = finished.try_send(());
                Err("stopped".into())
            }),
        )
        .unwrap();
        let mut first = connect(&server);
        first.write_all(&wire(br#"{"method":"wait"}"#)).unwrap();
        entry.recv_timeout(Duration::from_secs(2)).unwrap();
        let mut queued = connect(&server);
        queued.write_all(&wire(br#"{"method":"queued"}"#)).unwrap();
        server.shutdown();
        finish.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn stop_interrupts_read_exact_and_releases_a_partial_body_worker() {
        let (mut server, _) = server(Limits::default());
        let mut stream = connect(&server);
        stream
            .write_all(b"POST / HTTP/1.1\r\nX-Heeler-Token: secret\r\nContent-Length: 100\r\n\r\n{")
            .unwrap();
        // Exercise the cancellation error directly too: Read::read_exact retries
        // Interrupted indefinitely, so shutdown must return ConnectionAborted.
        let control = stream.try_clone().unwrap();
        let mut reader = SocketRead {
            stream: control,
            stop: Arc::new(AtomicBool::new(true)),
            deadline: Instant::now() + READ_DEADLINE,
        };
        assert_eq!(
            reader.read_exact(&mut [0; 1]).unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        server.shutdown();
        let until = Instant::now() + Duration::from_secs(2);
        while !server.sockets.lock().unwrap().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(server.sockets.lock().unwrap().is_empty());
    }
    #[test]
    fn saturation_stays_bounded_and_stop_releases_all_slots() {
        let (mut server, _) = server(Limits::default());
        let clients: Vec<_> = (0..CONNECTIONS + 4).map(|_| connect(&server)).collect();
        assert!(server.sockets.lock().unwrap().len() <= CONNECTIONS);
        server.shutdown();
        drop(clients);
        let until = Instant::now() + Duration::from_secs(2);
        while !server.sockets.lock().unwrap().is_empty() && Instant::now() < until {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(server.sockets.lock().unwrap().is_empty());
        let (fresh, _) = self::server(Limits::default());
        assert_eq!(ping(&fresh).0, 200);
    }
}
