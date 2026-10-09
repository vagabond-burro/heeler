//! The assistant's connection to a model server.
//!
//! Heeler talks to one OpenAI-compatible server the user names (LM
//! Studio, Ollama, llama.cpp), and only when that server is on this
//! computer. The rule is judged on the ADDRESS the name resolves to,
//! never on the name or the port, and the connection is opened to the
//! exact address that was checked: the name is looked up once per
//! connection, every address it returns is classified, and the HTTP
//! client is handed those addresses and nothing else. A second lookup
//! could answer differently from the first (DNS rebinding), so there is
//! no second lookup.
//!
//! What is allowed:
//!
//! - loopback (127.0.0.0/8,::1) and this computer's own network
//! addresses (a `.local` name for the same Mac);
//! - another machine of the home network, where most people run their
//! model server because models take a lot of memory (the owner's is
//! `canyonlands.local:1234`): the IPv4 home ranges, IPv4
//! self-assigned, IPv6 link-local and unique local, and an IPv6
//! global address only when it shares the /64 prefix of one of this
//! computer's own addresses. On in every build since 2026-09-29
//! ("add the sentence and turn on home network"), with the privacy
//! policy's sentence saying so. The internet is never reached.
//!
//! Nothing is sent anywhere except the checked address, nothing goes to
//! Vagabond Burro, and message contents are never logged: the DEBUG
//! tier records sizes and timings only.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager as _;

/// The notice shown when the assistant is switched on, recorded once
/// with its date (the receipt's shape, agreement.rs). The version
/// is the date the words last changed, so a later edit asks again.
pub const DISCLAIMER_DOCUMENT: &str = "Heeler assistant notice";
pub const DISCLAIMER_VERSION: &str = "2026-09-28";
const DISCLAIMER_FILE: &str = "assistant-notice-accepted.txt";
/// Untested models the user acknowledged, one line each, with the date.
const ACKNOWLEDGED_FILE: &str = "assistant-models-acknowledged.txt";
/// The acknowledgment's words, written at the top of the record so the
/// file says what was agreed to when a person opens it.
pub const ACKNOWLEDGMENT: &str =
    "This model has not been tested with Heeler. Its license and its answers are the responsibility of whoever runs it.";

/// The models tested with Heeler.
///
/// "Tested" means two things: the license was checked on the model card
/// (code and weights Apache-2.0 or MIT), and Heeler's own tasks were run
/// against it (Help answers citing the right chapter, guided tours that
/// validate). Entries are model names as a server reports them, compared
/// by `model_key` (case and a trailing quantization tag ignored).
/// Changing this list is changing Heeler.
///
/// Qwen3-30B-A3B-Instruct-2507 (Apache-2.0), added 2026-09-29 at the
/// owner's word after the assistant was built and reviewed against it on
/// his LM Studio server: chapter picks 33 of 34, tours 7 of 7 valid. Only
/// the 2507 Instruct release: the earlier Qwen3-30B-A3B and the Thinking
/// variant were not run. Its names as LM Studio (the owner's server),
/// Hugging Face and LM Studio's community uploads, and Ollama report it.
pub const TESTED_MODELS: &[&str] = &[
    "qwen/qwen3-30b-a3b-2507",
    "qwen3-30b-a3b-instruct-2507",
    "qwen3:30b-a3b-instruct-2507",
];

/// How long the model list may take. A server that is up answers this
/// in milliseconds; the margin is for a machine waking from sleep.
const VALIDATE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
/// How long one address gets to accept a plain connection when Heeler
/// looks for the first that answers (a model server on this computer or
/// the home network answers in milliseconds).
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long an answer may take. A small model on a laptop with a
/// guide chapter in its prompt can think for a minute or two; five
/// minutes is generous and still ends.
const CHAT_TIMEOUT: Duration = Duration::from_secs(300);

// -- the address -------------------------------------------------------

/// A server address as the user typed it, taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// The host as typed, without brackets: a name or an IP literal.
    pub host: String,
    pub port: u16,
}

impl Endpoint {
    /// The host as it goes into a URL and the Host header: IPv6
    /// literals wear brackets.
    fn url_host(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}:{}{}", self.url_host(), self.port, path)
    }

    /// What the HTTP client hands its resolver: `host:port`, exactly as
    /// ureq builds it from the URL above.
    fn netloc(&self) -> String {
        format!("{}:{}", self.url_host(), self.port)
    }
}

/// Reads `http://host:port`, `host:port`, `http://[::1]:1234` or a bare
/// host. The port is what the user typed, or http's own 80 when none
/// was: nothing is assumed about which server they run. A trailing
/// `/v1` (the base URL LM Studio shows) is accepted and dropped.
pub fn parse_address(input: &str) -> Result<Endpoint, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("Type the server's address, for example http://localhost:1234.".into());
    }
    let rest = if let Some(r) = s.strip_prefix("http://") {
        r
    } else if s.starts_with("https://") {
        return Err("Local servers answer over http, not https: start the address with http://.".into());
    } else if s.contains("://") {
        return Err("The address must start with http:// (or leave the scheme off).".into());
    } else {
        s
    };
    // The authority ends at the first slash; a path is allowed only as
    // the /v1 base LM Studio shows, or empty.
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let path = path.trim_end_matches('/');
    if !(path.is_empty() || path == "/v1") {
        return Err(format!("The address is the server alone, without a path: leave off \"{path}\"."));
    }
    if authority.contains('@') {
        return Err("The address cannot carry a user name or password.".into());
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        let end = after.find(']').ok_or("An IPv6 address needs its closing bracket, as in http://[::1]:1234.")?;
        let host = &after[..end];
        let tail = &after[end + 1..];
        let port = match tail.strip_prefix(':') {
            Some(p) => Some(p),
            None if tail.is_empty() => None,
            None => return Err("Nothing may follow the IPv6 address but a port.".into()),
        };
        (host.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, _)) if h.contains(':') => {
                return Err("Put an IPv6 address in brackets, as in http://[::1]:1234.".into());
            }
            Some((h, p)) => (h.to_string(), Some(p)),
            None => (authority.to_string(), None),
        }
    };
    if host.is_empty() {
        return Err("The address has no host name.".into());
    }
    let port = match port {
        None => 80,
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => n,
            _ => return Err(format!("\"{p}\" is not a port number.")),
        },
    };
    Ok(Endpoint { host, port })
}

// -- the classification --------------------------------------------------

/// Why an address may be reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// 127.0.0.0/8 or ::1.
    Loopback,
    /// One of this computer's own network addresses.
    ThisComputer,
    /// Another machine on the home network.
    HomeNetwork,
}

/// An IPv4 address carried inside IPv6 (::ffff:a.b.c.d) is judged as
/// the IPv4 address it is.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => IpAddr::V6(v6),
        },
        v4 => v4,
    }
}

fn v4_home(ip: Ipv4Addr) -> bool {
    // 10/8, 172.16/12, 192.168/16, and self-assigned 169.254/16.
    ip.is_private() || ip.is_link_local()
}

fn v6_link_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xffc0) == 0xfe80
}

fn v6_unique_local(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

/// A global unicast IPv6 address: 2000::/3, the range providers hand
/// out, and the only one where the shared-prefix rule applies.
fn v6_global(ip: Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xe000) == 0x2000
}

fn same_64(a: Ipv6Addr, b: Ipv6Addr) -> bool {
    a.segments()[..4] == b.segments()[..4]
}

/// Whether `ip` may be reached, and why; None when it may not.
///
/// Pure: `own` is this computer's addresses (`own_addresses`), and
/// `home_network` is whether the build allows the home network at all,
/// passed in rather than read from the build so the tests reach both
/// answers.
pub fn classify(ip: IpAddr, own: &[IpAddr], home_network: bool) -> Option<Reach> {
    let ip = canonical(ip);
    if ip.is_unspecified() || ip.is_multicast() {
        return None;
    }
    if let IpAddr::V4(v4) = ip {
        if v4.is_broadcast() {
            return None;
        }
    }
    if ip.is_loopback() {
        return Some(Reach::Loopback);
    }
    if own.iter().any(|o| canonical(*o) == ip) {
        return Some(Reach::ThisComputer);
    }
    if !home_network {
        return None;
    }
    let home = match ip {
        IpAddr::V4(v4) => v4_home(v4),
        IpAddr::V6(v6) => {
            v6_link_local(v6)
                || v6_unique_local(v6)
                || (v6_global(v6)
                    && own.iter().any(|o| match canonical(*o) {
                        IpAddr::V6(mine) => v6_global(mine) && same_64(mine, v6),
                        IpAddr::V4(_) => false,
                    }))
        }
    };
    home.then_some(Reach::HomeNetwork)
}

/// This computer's own network addresses. An enumeration that fails
/// leaves only loopback allowed, which is the safe direction.
pub fn own_addresses() -> Vec<IpAddr> {
    if_addrs::get_if_addrs()
        .map(|list| list.into_iter().map(|i| i.ip()).collect())
        .unwrap_or_default()
}

/// Whether a server elsewhere on the home network is allowed: yes, in
/// every build (the privacy policy says so). `classify` keeps the switch
/// as a parameter so the tests read the table both ways.
fn home_network_allowed() -> bool {
    true
}

/// The outcome of checking a name: the addresses to connect to, or the
/// first address that is not allowed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    Allowed(Vec<SocketAddr>),
    /// The address that failed the check, as the user will read it.
    NotLocal(IpAddr),
    /// The name did not resolve to anything.
    Unresolved(String),
}

/// Judges every address a lookup returned. One refused address refuses
/// the name: a name that answers with an internet address beside a
/// local one is exactly the name that cannot be trusted.
pub fn check_resolved(addrs: &[SocketAddr], own: &[IpAddr], home_network: bool) -> Checked {
    if addrs.is_empty() {
        return Checked::Unresolved("the name did not resolve to any address".into());
    }
    for a in addrs {
        if classify(a.ip(), own, home_network).is_none() {
            return Checked::NotLocal(canonical(a.ip()));
        }
    }
    Checked::Allowed(addrs.to_vec())
}

/// Resolves the name ONCE and checks what came back.
fn resolve_and_check(ep: &Endpoint, own: &[IpAddr], home_network: bool) -> Checked {
    match (ep.host.as_str(), ep.port).to_socket_addrs() {
        Ok(it) => check_resolved(&it.collect::<Vec<_>>(), own, home_network),
        Err(e) => Checked::Unresolved(e.to_string()),
    }
}

/// The checked addresses in the order worth trying: IPv4 first (local
/// model servers commonly listen on IPv4 only), then IPv6 with a global
/// or unique local address, then link-local; duplicates removed, order
/// within each group kept.
pub fn connect_order(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let rank = |a: &SocketAddr| match a.ip() {
        IpAddr::V4(_) => 0,
        IpAddr::V6(v6) if (v6.segments()[0] & 0xffc0) == 0xfe80 => 2,
        IpAddr::V6(_) => 1,
    };
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<SocketAddr> = addrs.into_iter().filter(|a| seen.insert(*a)).collect();
    out.sort_by_key(rank);
    out
}

/// The first address that accepts a plain connection, alone, so the
/// request that follows gets the whole connect timeout; every address,
/// in order, when none does (the request then fails as it would have).
/// Tries only what it is given, which is only what passed the check.
pub fn reachable_first(addrs: Vec<SocketAddr>, each: Duration) -> Vec<SocketAddr> {
    if addrs.len() < 2 {
        return addrs;
    }
    for a in &addrs {
        if std::net::TcpStream::connect_timeout(a, each).is_ok() {
            return vec![*a];
        }
    }
    addrs
}

/// What a transport failure means, by how long the call ran: the answer
/// timeout only when the call ran that long, never for a connection that
/// failed in seconds (which ureq also reports as "timed out" when its
/// connect deadline runs out).
pub fn transport_words(elapsed: Duration, timeout: Duration, host: &str) -> String {
    if elapsed + Duration::from_secs(1) >= timeout {
        "The model took longer than five minutes to answer, so Heeler stopped waiting.".into()
    } else {
        format!("Heeler could not connect to the server at {host}. Is it running, and set to serve on the network?")
    }
}

/// An HTTP client that can only reach `addrs`: its resolver answers the
/// checked addresses for this endpoint and refuses anything else, it
/// follows no redirect and reads no proxy from the environment. The URL
/// keeps the name, so the Host header is the one the user typed.
fn pinned_agent(ep: &Endpoint, addrs: Vec<SocketAddr>, timeout: Duration) -> ureq::Agent {
    // The checked addresses in the order to try, and when one answers a plain
    // connection, that one alone: ureq halves one shared connect deadline
    // across every address it is given, so a name with many silent or
    // refusing addresses ahead of the working one ran out of time before
    // reaching it (2026-09-29: canyonlands.local gave twelve IPv6 addresses,
    // each refusing after about a second, ahead of the IPv4 ones LM Studio
    // listens on, and the chat failed in under ten seconds). Only addresses
    // that passed the check are ever tried.
    let addrs = reachable_first(connect_order(addrs), PROBE_TIMEOUT);
    let expected = ep.netloc();
    ureq::AgentBuilder::new()
        .resolver(move |netloc: &str| -> std::io::Result<Vec<SocketAddr>> {
            if netloc == expected {
                Ok(addrs.clone())
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    format!("the assistant connects only to {expected}"),
                ))
            }
        })
        .redirects(0)
        .try_proxy_from_env(false)
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
}

// -- validate --------------------------------------------------------------

/// One model the server offers.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    /// On Heeler's tested list.
    pub tested: bool,
}

/// What Validate found, for the Preferences panel to put in words.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Validation {
    /// The address could not be read.
    BadAddress { reason: String },
    /// The name did not resolve.
    NotFound { host: String, reason: String },
    /// The address is neither this computer nor the home network.
    NotLocal { host: String, address: String },
    /// Nothing answers there.
    NothingAnswering { address: String },
    /// Something answers, but not as a model server.
    NotAModelServer { address: String, status: u16 },
    /// A model server with no model loaded.
    NoModels { address: String },
    /// Connected, with the models the server lists.
    Connected { address: String, models: Vec<ModelEntry> },
}

/// The name Heeler compares models by: lower case, without a trailing
/// quantization or format tag (LM Studio's `@q4_k_m`, a `-Q4_K_M`,
/// `:q8_0`, `-fp16`, `-4bit`, `-gguf`, `-mlx`). A name is not proof of
/// the weights behind it, which is why the acknowledgment, not this
/// match, carries the user's responsibility.
pub fn model_key(name: &str) -> String {
    let mut s = name.trim().to_lowercase();
    if let Some(i) = s.find('@') {
        s.truncate(i);
    }
    fn is_tag(t: &str) -> bool {
        let t = t.trim();
        if matches!(t, "fp16" | "bf16" | "f16" | "f32" | "fp32" | "gguf" | "mlx" | "int4" | "int8") {
            return true;
        }
        if let Some(n) = t.strip_suffix("bit") {
            return !n.is_empty() && n.chars().all(|c| c.is_ascii_digit());
        }
        // q4, q8_0, q4_k_m, q5_k_s, iq4_xs
        let body = t.strip_prefix("iq").or_else(|| t.strip_prefix('q'));
        match body {
            Some(b) => {
                let mut parts = b.split('_');
                let first = parts.next().unwrap_or("");
                !first.is_empty()
                    && first.chars().all(|c| c.is_ascii_digit())
                    && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric()) && p.len() <= 2)
            }
            None => false,
        }
    }
    loop {
        // The last separator that is not inside a q-tag's own underscores.
        let cut = s.rfind(['-', ':', '.', '/']);
        let Some(i) = cut else { break };
        let tail = &s[i + 1..];
        if i > 0 && is_tag(tail) {
            s.truncate(i);
        } else {
            break;
        }
    }
    s
}

pub fn is_tested(name: &str, tested: &[&str]) -> bool {
    let key = model_key(name);
    tested.iter().any(|t| model_key(t) == key)
}

fn host_label(ep: &Endpoint) -> String {
    format!("{}:{}", ep.url_host(), ep.port)
}

/// Validate, with everything that varies passed in.
pub fn validate_with(address: &str, own: &[IpAddr], home_network: bool, tested: &[&str]) -> Validation {
    let ep = match parse_address(address) {
        Ok(ep) => ep,
        Err(reason) => return Validation::BadAddress { reason },
    };
    let addrs = match resolve_and_check(&ep, own, home_network) {
        Checked::Allowed(a) => a,
        Checked::NotLocal(ip) => {
            return Validation::NotLocal { host: host_label(&ep), address: ip.to_string() };
        }
        Checked::Unresolved(reason) => return Validation::NotFound { host: host_label(&ep), reason },
    };
    // Ordered and probed here rather than in pinned_agent, so the address
    // the answer names is the one actually used.
    let addrs = reachable_first(connect_order(addrs), PROBE_TIMEOUT);
    let shown = addrs.first().map(|a| a.to_string()).unwrap_or_default();
    let agent = pinned_agent(&ep, addrs, VALIDATE_TIMEOUT);
    let resp = match agent.get(&ep.url("/v1/models")).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Validation::NotAModelServer { address: shown, status: code };
        }
        Err(ureq::Error::Transport(_)) => return Validation::NothingAnswering { address: shown },
    };
    let body: serde_json::Value = match resp.into_string().ok().and_then(|t| serde_json::from_str(&t).ok()) {
        Some(v) => v,
        None => return Validation::NotAModelServer { address: shown, status: 200 },
    };
    let Some(list) = body.get("data").and_then(|d| d.as_array()) else {
        return Validation::NotAModelServer { address: shown, status: 200 };
    };
    let models: Vec<ModelEntry> = list
        .iter()
        .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
        .filter(|id| !id.trim().is_empty())
        .map(|id| ModelEntry { id: id.to_string(), tested: is_tested(id, tested) })
        .collect();
    if models.is_empty() {
        Validation::NoModels { address: shown }
    } else {
        Validation::Connected { address: shown, models }
    }
}

// -- chat --------------------------------------------------------------------

/// One turn of the conversation, in the OpenAI shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// Reasoning models (Qwen3 and others) put their working inside
/// `<think>` tags ahead of the answer; the user asked for the answer.
pub fn strip_thinking(reply: &str) -> String {
    let mut out = reply.to_string();
    while let Some(start) = out.find("<think>") {
        match out[start..].find("</think>") {
            Some(end) => out.replace_range(start..start + end + "</think>".len(), ""),
            // Unclosed: the model ran out of room while thinking, and
            // nothing after the tag is an answer.
            None => out.truncate(start),
        }
    }
    out.trim().to_string()
}

/// The chat, with everything that varies passed in. Returns the reply,
/// or why there is none, in words.
pub fn chat_with(
    address: &str,
    model: &str,
    messages: &[ChatMessage],
    own: &[IpAddr],
    home_network: bool,
    timeout: Duration,
    temperature: f32,
) -> Result<String, String> {
    let ep = parse_address(address)?;
    let addrs = match resolve_and_check(&ep, own, home_network) {
        Checked::Allowed(a) => a,
        Checked::NotLocal(ip) => {
            return Err(format!(
                "{} resolves to {ip}, which is neither this computer nor the home network, so the assistant will not send to it.",
                host_label(&ep)
            ));
        }
        Checked::Unresolved(reason) => return Err(format!("{} could not be found: {reason}.", host_label(&ep))),
    };
    let agent = pinned_agent(&ep, addrs, timeout);
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "temperature": temperature,
    });
    let started = std::time::Instant::now();
    let resp = match agent
        .post(&ep.url("/v1/chat/completions"))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
    {
        Ok(r) => r,
        Err(ureq::Error::Status(code, r)) => {
            let detail = r
                .into_string()
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| {
                    v.pointer("/error/message")
                        .or_else(|| v.get("error"))
                        .and_then(|m| m.as_str().map(str::to_string))
                })
                .unwrap_or_default();
            return Err(if detail.is_empty() {
                format!("The server refused the question (HTTP {code}).")
            } else {
                format!("The server refused the question (HTTP {code}): {detail}")
            });
        }
        Err(ureq::Error::Transport(t)) => {
            return Err(if t.to_string().contains("timed out") {
                transport_words(started.elapsed(), timeout, &host_label(&ep))
            } else {
                format!("Nothing answers at {} now. Is the server still running?", host_label(&ep))
            });
        }
    };
    let v: serde_json::Value = resp
        .into_string()
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or("The server's answer was not one Heeler can read.")?;
    let text = v
        .pointer("/choices/0/message/content")
        .and_then(|c| c.as_str())
        .ok_or("The server answered without a reply in it.")?;
    let text = strip_thinking(text);
    if text.is_empty() {
        return Err("The model answered with nothing.".into());
    }
    Ok(text)
}

// -- the context length --------------------------------------------------------

/// How many tokens the model is loaded with, when the server says: LM
/// Studio's own /api/v0/models lists `loaded_context_length` for a
/// loaded model. Its `max_context_length` is what the model could be
/// loaded with, not what the server will accept now (the owner's Qwen3
/// reports 262,144 there and is loaded at 8,192), so it is never used.
/// Any other server, or any failure, is `None`, and the assistant keeps
/// the budget tuned for 4,096 tokens.
pub fn context_length_with(address: &str, model: &str, own: &[IpAddr], home_network: bool) -> Option<u32> {
    let ep = parse_address(address).ok()?;
    let Checked::Allowed(addrs) = resolve_and_check(&ep, own, home_network) else { return None };
    let agent = pinned_agent(&ep, addrs, VALIDATE_TIMEOUT);
    let text = agent.get(&ep.url("/api/v0/models")).call().ok()?.into_string().ok()?;
    let body: serde_json::Value = serde_json::from_str(&text).ok()?;
    let key = model_key(model);
    let entry = body.get("data")?.as_array()?.iter().find(|m| {
        m.get("id").and_then(|i| i.as_str()).is_some_and(|id| id == model || model_key(id) == key)
    })?;
    if entry.get("state").and_then(|s| s.as_str()).is_some_and(|s| s != "loaded") {
        return None;
    }
    let n = entry.get("loaded_context_length")?.as_u64()?;
    u32::try_from(n).ok().filter(|n| *n > 0)
}

// -- the records ------------------------------------------------------------

/// Records kept in the app data folder, never in a photograph's graph or
/// the catalog: they belong to this installation.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Acknowledged {
    pub model: String,
    pub unix_time: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Records {
    pub disclaimer: Option<crate::agreement::Acceptance>,
    pub acknowledged: Vec<Acknowledged>,
    /// The words and version this build presents, so the panel and the
    /// record cannot drift apart.
    pub disclaimer_version: String,
}

fn render_acknowledged(list: &[Acknowledged]) -> String {
    let mut s = format!("Untested assistant models acknowledged: \"{ACKNOWLEDGMENT}\"\n");
    for a in list {
        s.push_str(&format!("acknowledged: {} {}\n", a.unix_time, a.model));
    }
    s
}

/// Total, like the receipt parser: a line that is not a record is
/// skipped, so a damaged file asks again rather than assuming consent.
fn parse_acknowledged(text: &str) -> Vec<Acknowledged> {
    text.lines()
        .filter_map(|l| {
            let rest = l.strip_prefix("acknowledged: ")?;
            let (t, model) = rest.split_once(' ')?;
            let model = model.trim();
            let unix_time = t.parse().ok()?;
            (!model.is_empty()).then(|| Acknowledged { model: model.to_string(), unix_time })
        })
        .collect()
}

fn read_records(dir: &Path) -> Records {
    let disclaimer = std::fs::read_to_string(dir.join(DISCLAIMER_FILE))
        .ok()
        .as_deref()
        .and_then(crate::agreement::parse)
        .filter(|a| a.document == DISCLAIMER_DOCUMENT);
    let acknowledged = std::fs::read_to_string(dir.join(ACKNOWLEDGED_FILE))
        .map(|t| parse_acknowledged(&t))
        .unwrap_or_default();
    Records { disclaimer, acknowledged, disclaimer_version: DISCLAIMER_VERSION.into() }
}

fn accept_disclaimer_in(dir: &Path, unix_time: i64, fingerprint: &str) -> Result<crate::agreement::Acceptance, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(DISCLAIMER_FILE);
    std::fs::write(&path, crate::agreement::render(DISCLAIMER_DOCUMENT, DISCLAIMER_VERSION, unix_time, fingerprint))
        .map_err(|e| format!("could not record the notice at {}: {e}", path.display()))?;
    Ok(crate::agreement::Acceptance {
        document: DISCLAIMER_DOCUMENT.into(),
        version: DISCLAIMER_VERSION.into(),
        unix_time,
        fingerprint: fingerprint.into(),
    })
}

fn acknowledge_in(dir: &Path, model: &str, unix_time: i64) -> Result<Vec<Acknowledged>, String> {
    let model = model.trim();
    if model.is_empty() || model.contains('\n') {
        return Err("That is not a model name.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(ACKNOWLEDGED_FILE);
    let mut list = std::fs::read_to_string(&path).map(|t| parse_acknowledged(&t)).unwrap_or_default();
    if !list.iter().any(|a| model_key(&a.model) == model_key(model)) {
        list.push(Acknowledged { model: model.to_string(), unix_time });
    }
    std::fs::write(&path, render_acknowledged(&list))
        .map_err(|e| format!("could not record the acknowledgment at {}: {e}", path.display()))?;
    Ok(list)
}

/// Whether the assistant may run here: the notice accepted, and the
/// model tested or acknowledged. The window checks both before it offers
/// a control; this is the second wall, for a call from the devtools
/// console.
///
/// The assistant only answers questions; anything that would change the
/// edit goes through the reducer.
fn gate(dir: &Path, model: Option<&str>) -> Result<(), String> {
    let records = read_records(dir);
    match &records.disclaimer {
        Some(a) if a.version == DISCLAIMER_VERSION => {}
        _ => return Err("The assistant is off: turn it on in Preferences > Assistant and accept its notice first.".into()),
    }
    if let Some(model) = model {
        let known = is_tested(model, TESTED_MODELS)
            || records.acknowledged.iter().any(|a| model_key(&a.model) == model_key(model));
        if !known {
            return Err(format!(
                "{model} has not been tested with Heeler. Pick it in Preferences > Assistant and acknowledge it first."
            ));
        }
    }
    Ok(())
}

fn data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

// -- commands ------------------------------------------------------------------

#[tauri::command]
pub async fn assistant_records(app: tauri::AppHandle) -> Result<Records, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(read_records(&data_dir(&app)?)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_accept_disclaimer(app: tauri::AppHandle) -> Result<crate::agreement::Acceptance, String> {
    tauri::async_runtime::spawn_blocking(move || {
        accept_disclaimer_in(&data_dir(&app)?, crate::agreement::now(), &crate::machine::fingerprint())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_acknowledge_model(app: tauri::AppHandle, model: String) -> Result<Vec<Acknowledged>, String> {
    tauri::async_runtime::spawn_blocking(move || acknowledge_in(&data_dir(&app)?, &model, crate::agreement::now()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn assistant_validate(app: tauri::AppHandle, address: String) -> Result<Validation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gate(&data_dir(&app)?, None)?;
        let t0 = Instant::now();
        let out = validate_with(&address, &own_addresses(), home_network_allowed(), TESTED_MODELS);
        crate::debug_log!(&app, "Assistant: validate answered in {} ms", t0.elapsed().as_millis());
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The model's loaded context length in tokens, when the server reports
/// it (LM Studio does); `None` otherwise. Nothing of the conversation
/// is sent.
#[tauri::command]
pub async fn assistant_context_length(app: tauri::AppHandle, address: String, model: String) -> Result<Option<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gate(&data_dir(&app)?, Some(&model))?;
        let n = context_length_with(&address, &model, &own_addresses(), home_network_allowed());
        crate::debug_log!(&app, "Assistant: context length {}", n.map_or("not reported".to_string(), |n| n.to_string()));
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `temperature` is 0.2 unless given: the table-of-contents step asks
/// for 0, since it wants the same chapters for the same question.
#[tauri::command]
pub async fn assistant_chat(
    app: tauri::AppHandle,
    address: String,
    model: String,
    messages: Vec<ChatMessage>,
    temperature: Option<f32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        gate(&data_dir(&app)?, Some(&model))?;
        // Sizes and timings only, never the words.
        let sent: usize = messages.iter().map(|m| m.content.len()).sum();
        let t0 = Instant::now();
        let temperature = temperature.filter(|t| t.is_finite()).unwrap_or(0.2).clamp(0.0, 1.0);
        let out = chat_with(&address, &model, &messages, &own_addresses(), home_network_allowed(), CHAT_TIMEOUT, temperature);
        crate::debug_log!(
            &app,
            "Assistant: {} messages, {} bytes sent, {} in {} ms",
            messages.len(),
            sent,
            match &out {
                Ok(r) => format!("{} bytes back", r.len()),
                Err(_) => "no reply".to_string(),
            },
            t0.elapsed().as_millis()
        );
        out
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn v4(s: &str) -> IpAddr {
        IpAddr::V4(s.parse::<Ipv4Addr>().unwrap())
    }
    fn v6(s: &str) -> IpAddr {
        IpAddr::V6(s.parse::<Ipv6Addr>().unwrap())
    }

    /// This computer, as the owner's Mac is on his network: a home IPv4
    /// address and a provider-assigned global IPv6 address.
    fn mac() -> Vec<IpAddr> {
        vec![v4("192.168.1.20"), v6("2600:1700:4390:def0::20"), v6("fe80::1")]
    }

    #[test]
    fn the_address_is_read_as_typed() {
        let ep = |s: &str| parse_address(s).unwrap();
        assert_eq!(ep("http://localhost:1234"), Endpoint { host: "localhost".into(), port: 1234 });
        assert_eq!(ep("localhost:1234"), Endpoint { host: "localhost".into(), port: 1234 });
        assert_eq!(ep(" http://canyonlands.local:1234/ "), Endpoint { host: "canyonlands.local".into(), port: 1234 });
        // LM Studio shows its base URL with /v1; that is accepted.
        assert_eq!(ep("http://localhost:1234/v1"), Endpoint { host: "localhost".into(), port: 1234 });
        assert_eq!(ep("http://[::1]:11434"), Endpoint { host: "::1".into(), port: 11434 });
        // No port assumed beyond http's own.
        assert_eq!(ep("http://localhost"), Endpoint { host: "localhost".into(), port: 80 });
        assert_eq!(ep("[::1]"), Endpoint { host: "::1".into(), port: 80 });
        for bad in ["", "https://localhost:1234", "ftp://x", "http://:1234", "http://localhost:0", "http://localhost:99999",
            "http://localhost:12ab", "http://::1:1234", "http://[::1", "http://u:p@localhost:1", "http://localhost:1234/chat"] {
            assert!(parse_address(bad).is_err(), "accepted {bad:?}");
        }
        // The Host header keeps the name; IPv6 wears brackets.
        assert_eq!(ep("http://[::1]:5").netloc(), "[::1]:5");
        assert_eq!(ep("http://canyonlands.local:1234").url("/v1/models"), "http://canyonlands.local:1234/v1/models");
    }

    /// The whole table, release and development.
    #[test]
    fn every_address_is_classified() {
        let own = mac();
        let rel = |ip: IpAddr| classify(ip, &own, false);
        let dev = |ip: IpAddr| classify(ip, &own, true);
        // Loopback, everywhere, including the IPv4-mapped form.
        for ip in [v4("127.0.0.1"), v4("127.8.9.10"), v6("::1"), v6("::ffff:127.0.0.1")] {
            assert_eq!(rel(ip), Some(Reach::Loopback), "{ip}");
            assert_eq!(dev(ip), Some(Reach::Loopback), "{ip}");
        }
        // This computer's own addresses, everywhere.
        for ip in [v4("192.168.1.20"), v6("2600:1700:4390:def0::20"), v6("fe80::1"), v6("::ffff:192.168.1.20")] {
            assert_eq!(rel(ip), Some(Reach::ThisComputer), "{ip}");
            assert_eq!(dev(ip), Some(Reach::ThisComputer), "{ip}");
        }
        // Another machine at home: only with the home network allowed.
        for ip in [
            v4("192.168.1.30"), v4("10.0.0.5"), v4("172.16.0.1"), v4("172.31.255.254"), v4("169.254.3.4"),
            v6("fe80::abcd"), v6("fd12:3456::1"), v6("fc00::1"),
            // canyonlands.local: a global address on this Mac's own /64.
            v6("2600:1700:4390:def0::1a2b"),
        ] {
            assert_eq!(rel(ip), None, "release reached {ip}");
            assert_eq!(dev(ip), Some(Reach::HomeNetwork), "dev refused {ip}");
        }
        // The internet: never.
        for ip in [
            v4("8.8.8.8"), v4("172.32.0.1"), v4("100.64.0.1"), v4("1.1.1.1"),
            // A global IPv6 address off this Mac's prefix, one hex digit away.
            v6("2600:1700:4390:def1::1"), v6("2001:4860:4860::8888"),
            v6("::ffff:8.8.8.8"),
            // Nothing addresses that are not one host.
            v4("0.0.0.0"), v6("::"), v4("255.255.255.255"), v4("224.0.0.1"), v6("ff02::1"),
        ] {
            assert_eq!(rel(ip), None, "release reached {ip}");
            assert_eq!(dev(ip), None, "dev reached {ip}");
        }
        // With no global address of its own, no global address shares a prefix.
        assert_eq!(classify(v6("2600:1700:4390:def0::1"), &[v4("192.168.1.20")], true), None);
    }

    /// Every build reaches a server elsewhere on the home network, the
    /// owner's canyonlands.local among them, and never the internet
    /// (2026-09-29: "add the sentence and turn on home network").
    #[test]
    fn every_build_reaches_the_home_network_and_never_the_internet() {
        assert!(home_network_allowed());
        let own = mac();
        let shipped = |ip: IpAddr| classify(ip, &own, home_network_allowed());
        for ip in [v4("192.168.1.141"), v4("10.0.0.5"), v6("2600:1700:4390:def0::1a2b"), v6("fd12::1")] {
            assert_eq!(shipped(ip), Some(Reach::HomeNetwork), "refused {ip}");
        }
        for ip in [v4("8.8.8.8"), v6("2600:1700:4390:def1::1"), v6("::ffff:8.8.8.8")] {
            assert_eq!(shipped(ip), None, "reached {ip}");
        }
    }

    /// One refused address refuses the whole name.
    #[test]
    fn a_name_is_judged_on_every_address_it_returns() {
        let own = mac();
        let sa = |ip: IpAddr| SocketAddr::new(ip, 1234);
        let both = [sa(v4("127.0.0.1")), sa(v6("::1"))];
        assert_eq!(check_resolved(&both, &own, false), Checked::Allowed(both.to_vec()));
        let rebound = [sa(v4("127.0.0.1")), sa(v4("93.184.216.34"))];
        assert_eq!(check_resolved(&rebound, &own, true), Checked::NotLocal(v4("93.184.216.34")));
        assert!(matches!(check_resolved(&[], &own, true), Checked::Unresolved(_)));
    }

    /// Preferences lists exactly the tested models (TESTED_MODEL_LIST in
    /// assistant.ts, 2026-09-29: "the model in the first column and the
    /// platform (LM Studio, Ollama) in the other"): every name here is a row
    /// there, and every row there is a name here.
    #[test]
    fn preferences_lists_exactly_the_tested_models() {
        let ts = include_str!("../../src/assistant.ts");
        let start = ts.find("export const TESTED_MODEL_LIST").expect("the list");
        let body = &ts[start..start + ts[start..].find("];").expect("list end")];
        let listed: Vec<&str> = body
            .split("model: \"")
            .skip(1)
            .map(|rest| &rest[..rest.find('"').expect("name end")])
            .collect();
        let mut want: Vec<&str> = TESTED_MODELS.to_vec();
        let mut got = listed.clone();
        want.sort_unstable();
        got.sort_unstable();
        assert_eq!(got, want, "Preferences' list and TESTED_MODELS differ");
        for platform in body.split("platform: \"").skip(1).map(|r| &r[..r.find('"').unwrap()]) {
            assert!(["LM Studio", "Ollama"].contains(&platform), "unknown platform {platform}");
        }
    }

    #[test]
    fn models_match_by_name_without_quantization() {
        for (a, b) in [
            ("qwen3-vl-4b-instruct@q4_k_m", "Qwen3-VL-4B-Instruct"),
            ("Qwen3-VL-4B-Instruct-Q4_K_M", "qwen3-vl-4b-instruct"),
            ("moondream2:q8_0", "moondream2"),
            ("smolvlm2-2.2b-instruct-mlx-4bit", "SmolVLM2-2.2B-Instruct"),
            ("model-fp16", "model"),
        ] {
            assert_eq!(model_key(a), model_key(b), "{a} vs {b}");
        }
        // The size is part of the name, never a tag.
        assert_ne!(model_key("qwen3-vl-2b"), model_key("qwen3-vl-4b"));
        assert_ne!(model_key("smolvlm2-2.2b"), model_key("smolvlm2"));
        assert!(is_tested("Moondream2@q4_k_m", &["moondream2"]));
        assert!(!is_tested("moondream2", &[]));
        // Qwen3-30B-A3B-Instruct-2507, by each server's name for it, and
        // nothing else of the family (2026-09-29).
        for name in [
            "qwen/qwen3-30b-a3b-2507",
            "Qwen3-30B-A3B-Instruct-2507",
            "qwen3-30b-a3b-instruct-2507-mlx-4bit",
            "Qwen3-30B-A3B-Instruct-2507-Q4_K_M",
            "qwen3:30b-a3b-instruct-2507-q4_K_M",
        ] {
            assert!(is_tested(name, TESTED_MODELS), "{name} not tested");
        }
        for name in ["qwen3-30b-a3b", "qwen/qwen3-30b-a3b", "qwen3-30b-a3b-thinking-2507", "qwen3:30b", "qwen3-vl-4b", "gemma-4-e4b"] {
            assert!(!is_tested(name, TESTED_MODELS), "{name} tested");
        }
    }

    #[test]
    fn thinking_is_not_the_answer() {
        assert_eq!(strip_thinking("<think>hm</think>\n\nThe answer."), "The answer.");
        assert_eq!(strip_thinking("Plain."), "Plain.");
        assert_eq!(strip_thinking("<think>ran out"), "");
    }

    #[test]
    fn records_round_trip_in_the_app_data_folder() {
        let dir = tempfile::tempdir().unwrap();
        let r = read_records(dir.path());
        assert!(r.disclaimer.is_none() && r.acknowledged.is_empty());
        let a = accept_disclaimer_in(dir.path(), 1_790_000_000, "fp").unwrap();
        assert_eq!(a.version, DISCLAIMER_VERSION);
        acknowledge_in(dir.path(), "qwen3-vl-4b@q4_k_m", 1_790_000_001).unwrap();
        // The same model under another quantization is the same model.
        let list = acknowledge_in(dir.path(), "Qwen3-VL-4B", 1_790_000_002).unwrap();
        assert_eq!(list, vec![Acknowledged { model: "qwen3-vl-4b@q4_k_m".into(), unix_time: 1_790_000_001 }]);
        let r = read_records(dir.path());
        assert_eq!(r.disclaimer.unwrap().unix_time, 1_790_000_000);
        assert_eq!(r.acknowledged.len(), 1);
        let text = std::fs::read_to_string(dir.path().join(ACKNOWLEDGED_FILE)).unwrap();
        assert!(text.starts_with("Untested assistant models acknowledged"), "{text}");
        assert!(acknowledge_in(dir.path(), " ", 1).is_err());
    }

    /// The gate asks only for the notice and, for an untested model, the
    /// acknowledgment.
    #[test]
    fn the_gate_asks_for_the_notice_and_the_acknowledgment() {
        let dir = tempfile::tempdir().unwrap();
        let e = gate(dir.path(), None).unwrap_err();
        assert!(e.contains("accept its notice"), "{e}");
        accept_disclaimer_in(dir.path(), 1, "fp").unwrap();
        assert!(gate(dir.path(), None).is_ok());
        // An untested model waits for its acknowledgment.
        let e = gate(dir.path(), Some("some-model")).unwrap_err();
        assert!(e.contains("has not been tested"), "{e}");
        acknowledge_in(dir.path(), "some-model", 2).unwrap();
        assert!(gate(dir.path(), Some("some-model@q4_k_m")).is_ok());
    }

    // -- the wire, against a mock server on 127.0.0.1 ------------------

    /// A tiny OpenAI-compatible server on a free loopback port. `models`
    /// is the /v1/models body; chat answers echo the Host header they
    /// arrived with and the message count, so a test can see what was
    /// sent. It serves `requests` requests and stops. LM Studio's own
    /// model list, as the owner's server answered it on 2026-09-28
    /// (trimmed): one model loaded at 8,192 tokens of a possible
    /// 262,144, one not loaded.
    const LM_STUDIO_MODELS: &str = r#"{"data":[
        {"id":"qwen/qwen3-30b-a3b-2507","state":"loaded","max_context_length":262144,"loaded_context_length":8192},
        {"id":"google/gemma-4-e4b","state":"not-loaded","max_context_length":131072}
    ],"object":"list"}"#;

    fn mock(models: &'static str, requests: usize) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..requests {
                let Ok(mut req) = server.recv() else { break };
                let host = req
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("Host"))
                    .map(|h| h.value.to_string())
                    .unwrap_or_default();
                seen.push(format!("{} {} host={host}", req.method(), req.url()));
                let (status, body) = match req.url() {
                    "/v1/models" if models == "404" => (404, "no".to_string()),
                    "/v1/models" => (200, models.to_string()),
                    "/api/v0/models" if models == "404" => (404, "no".to_string()),
                    "/api/v0/models" => (200, LM_STUDIO_MODELS.to_string()),
                    "/v1/chat/completions" => {
                        let mut b = String::new();
                        req.as_reader().read_to_string(&mut b).unwrap();
                        let v: serde_json::Value = serde_json::from_str(&b).unwrap();
                        let n = v["messages"].as_array().map(|a| a.len()).unwrap_or(0);
                        let model = v["model"].as_str().unwrap_or("").to_string();
                        if model == "refuse" {
                            (400, r#"{"error":{"message":"No model loaded"}}"#.to_string())
                        } else {
                            let reply = format!("<think>x</think>{n} messages to {model} via {host}. See adjustments/exposure.md.");
                            (200, serde_json::json!({"choices":[{"message":{"role":"assistant","content":reply}}]}).to_string())
                        }
                    }
                    _ => (404, String::new()),
                };
                let _ = req.respond(tiny_http::Response::from_string(body).with_status_code(status));
            }
            seen
        });
        (port, handle)
    }


    #[test]
    fn validate_says_connected_with_the_models() {
        let (port, h) = mock(r#"{"object":"list","data":[{"id":"qwen3-vl-4b@q4_k_m"},{"id":"moondream2"}]}"#, 1);
        let v = validate_with(&format!("http://127.0.0.1:{port}"), &[], false, &["moondream2"]);
        assert_eq!(
            v,
            Validation::Connected {
                address: format!("127.0.0.1:{port}"),
                models: vec![
                    ModelEntry { id: "qwen3-vl-4b@q4_k_m".into(), tested: false },
                    ModelEntry { id: "moondream2".into(), tested: true },
                ],
            }
        );
        assert_eq!(h.join().unwrap(), vec![format!("GET /v1/models host=127.0.0.1:{port}")]);
    }

    #[test]
    fn validate_says_no_models_and_not_a_model_server() {
        let (port, h) = mock(r#"{"object":"list","data":[]}"#, 1);
        assert_eq!(
            validate_with(&format!("127.0.0.1:{port}"), &[], false, &[]),
            Validation::NoModels { address: format!("127.0.0.1:{port}") }
        );
        h.join().unwrap();
        let (port, h) = mock("404", 1);
        assert_eq!(
            validate_with(&format!("127.0.0.1:{port}"), &[], false, &[]),
            Validation::NotAModelServer { address: format!("127.0.0.1:{port}"), status: 404 }
        );
        h.join().unwrap();
    }

    #[test]
    fn validate_says_nothing_answers() {
        // A port that was free a moment ago and is closed now.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert_eq!(
            validate_with(&format!("http://127.0.0.1:{port}"), &[], false, &[]),
            Validation::NothingAnswering { address: format!("127.0.0.1:{port}") }
        );
    }

    #[test]
    fn validate_refuses_an_address_off_this_computer_without_connecting() {
        // An internet address: refused on the address, before any
        // connection (a connection would hang or leave the machine).
        let v = validate_with("http://93.184.216.34:1234", &[], true, &[]);
        assert_eq!(v, Validation::NotLocal { host: "93.184.216.34:1234".into(), address: "93.184.216.34".into() });
        // A home address, with the home network switched off.
        let v = validate_with("http://192.168.1.30:1234", &mac(), false, &[]);
        assert!(matches!(v, Validation::NotLocal { .. }), "{v:?}");
        assert!(matches!(validate_with("https://localhost:1", &[], false, &[]), Validation::BadAddress { .. }));
    }

    /// The name is resolved once and the connection goes to the checked
    /// address with the name in the Host header: `localhost` is sent to
    /// the loopback address it resolved to, never looked up again.
    #[test]
    fn the_connection_goes_to_the_checked_address_with_the_name_as_host() {
        let (port, h) = mock(r#"{"data":[{"id":"m"}]}"#, 2);
        let ep = parse_address(&format!("http://localhost:{port}")).unwrap();
        // The resolver is pinned to 127.0.0.1 whatever localhost says.
        let agent = pinned_agent(&ep, vec![SocketAddr::from(([127, 0, 0, 1], port))], VALIDATE_TIMEOUT);
        let r = agent.get(&ep.url("/v1/models")).call().unwrap();
        assert_eq!(r.status(), 200);
        // Any other host is refused by the resolver, without a lookup.
        let other = agent.get(&format!("http://example.com:{port}/v1/models")).call();
        assert!(other.is_err(), "the pinned agent reached another host");
        // A chat to the same place, answered and cleaned of its thinking.
        let msgs = vec![
            ChatMessage { role: "system".into(), content: "guide".into() },
            ChatMessage { role: "user".into(), content: "How do I export?".into() },
        ];
        let reply = chat_with(&format!("http://127.0.0.1:{port}"), "m", &msgs, &[], false, CHAT_TIMEOUT, 0.2).unwrap();
        assert_eq!(reply, format!("2 messages to m via 127.0.0.1:{port}. See adjustments/exposure.md."));
        let seen = h.join().unwrap();
        assert_eq!(seen[0], format!("GET /v1/models host=localhost:{port}"));
        assert_eq!(seen[1], format!("POST /v1/chat/completions host=127.0.0.1:{port}"));
    }

    #[test]
    fn a_refused_chat_says_why() {
        let (port, h) = mock(r#"{"data":[]}"#, 1);
        let msgs = vec![ChatMessage { role: "user".into(), content: "hi".into() }];
        let e = chat_with(&format!("http://127.0.0.1:{port}"), "refuse", &msgs, &[], false, CHAT_TIMEOUT, 0.2).unwrap_err();
        assert_eq!(e, "The server refused the question (HTTP 400): No model loaded");
        h.join().unwrap();
        let e = chat_with("http://8.8.8.8:1234", "m", &msgs, &[], true, CHAT_TIMEOUT, 0.2).unwrap_err();
        assert!(e.contains("neither this computer nor the home network"), "{e}");
    }

    #[test]
    fn the_context_length_is_the_loaded_one_when_the_server_says() {
        let (port, h) = mock(r#"{"data":[]}"#, 3);
        let at = format!("http://127.0.0.1:{port}");
        assert_eq!(context_length_with(&at, "qwen/qwen3-30b-a3b-2507@4bit", &[], false), Some(8192));
        // Not loaded: its maximum is not what the server will take.
        assert_eq!(context_length_with(&at, "google/gemma-4-e4b", &[], false), None);
        assert_eq!(context_length_with(&at, "unknown", &[], false), None);
        h.join().unwrap();
        // A server without LM Studio's list (Ollama) is simply unknown.
        let (port, h) = mock("404", 1);
        assert_eq!(context_length_with(&format!("http://127.0.0.1:{port}"), "m", &[], false), None);
        h.join().unwrap();
        // Off this computer: nothing is asked.
        assert_eq!(context_length_with("http://8.8.8.8:1234", "m", &[], false), None);
    }

    /// 2026-09-29: a chat failed in under ten seconds with "longer than five
    /// minutes"; canyonlands.local resolved to twelve IPv6 addresses (each
    /// refusing after about a second) ahead of the IPv4 ones LM Studio
    /// listens on, and ureq's halving connect deadline ran out.
    #[test]
    fn addresses_are_tried_ipv4_first_without_duplicates() {
        let a = |s: &str| s.parse::<SocketAddr>().unwrap();
        let got = connect_order(vec![
            a("[fe80::1]:1234"),
            a("[2600:1700:4390:def0::38]:1234"),
            a("192.168.1.141:1234"),
            a("[2600:1700:4390:def0::38]:1234"),
            a("192.168.1.249:1234"),
            a("192.168.1.141:1234"),
        ]);
        assert_eq!(
            got,
            vec![a("192.168.1.141:1234"), a("192.168.1.249:1234"), a("[2600:1700:4390:def0::38]:1234"), a("[fe80::1]:1234")]
        );
    }

    #[test]
    fn the_first_address_that_answers_is_the_one_pinned() {
        let open = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let open_addr = open.local_addr().unwrap();
        // A port that was free a moment ago: nothing listens, it refuses.
        let closed_addr = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        let got = reachable_first(vec![closed_addr, open_addr], Duration::from_millis(500));
        assert_eq!(got, vec![open_addr]);
        // None answering: every address stays, in order, for the request to fail on.
        let closed2 = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        assert_eq!(reachable_first(vec![closed_addr, closed2], Duration::from_millis(200)), vec![closed_addr, closed2]);
        // One address: no probe at all.
        assert_eq!(reachable_first(vec![closed_addr], Duration::from_millis(200)), vec![closed_addr]);
        drop(open);
    }

    #[test]
    fn a_quick_failure_is_never_called_a_five_minute_wait() {
        let quick = transport_words(Duration::from_secs(8), CHAT_TIMEOUT, "canyonlands.local:1234");
        assert!(quick.starts_with("Heeler could not connect to the server at canyonlands.local:1234"), "{quick}");
        assert!(!quick.contains("five minutes"));
        let long = transport_words(CHAT_TIMEOUT, CHAT_TIMEOUT, "canyonlands.local:1234");
        assert!(long.contains("five minutes"), "{long}");
    }

    /// Live, by hand only: `HEELER_ASSISTANT_LIVE=http://canyonlands.local:1234
    /// cargo test -p heeler-desktop --lib live_server -- --ignored --nocapture`.
    /// Validate and one short chat through the real resolver, order and probe.
    #[test]
    #[ignore]
    fn live_server_answers_through_the_pinned_connection() {
        let Ok(address) = std::env::var("HEELER_ASSISTANT_LIVE") else { return };
        let model = std::env::var("HEELER_ASSISTANT_MODEL").unwrap_or_else(|_| "qwen/qwen3-30b-a3b-2507".into());
        for round in 0..3 {
            let t = Instant::now();
            let v = validate_with(&address, &own_addresses(), true, TESTED_MODELS);
            println!("round {round} validate {:?} in {:?}", v, t.elapsed());
            let t = Instant::now();
            let msgs = vec![ChatMessage { role: "user".into(), content: "Reply with the single word ok.".into() }];
            let r = chat_with(&address, &model, &msgs, &own_addresses(), true, CHAT_TIMEOUT, 0.0);
            println!("round {round} chat {:?} in {:?}", r, t.elapsed());
            assert!(r.is_ok(), "{r:?}");
        }
    }
}
