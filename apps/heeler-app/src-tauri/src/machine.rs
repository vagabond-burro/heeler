//! This machine, as the Assistant notice's receipt names it, and the OS's own
//! opener for a URL.
//!
//! The receipt records a
//! FINGERPRINT: a sha256 over stable identity (the Windows machine GUID,
//! the Mac's platform UUID or Linux's machine-id, CPU identity, OS and
//! arch). Only the digest is written; the components never leave the
//! process.

use sha2::Digest as _;

/// The digest of the components, each followed by a zero byte so no
/// two component lists can run together into the same input.
fn fingerprint_of(components: &[String]) -> String {
    let mut h = sha2::Sha256::new();
    for c in components {
        h.update(c.as_bytes());
        h.update([0u8]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// -- machine identity -------------------------------------------------

#[cfg(windows)]
fn windows_machine_guid() -> Option<String> {
    use std::os::windows::process::CommandExt as _;
    // reg.exe's value and type tokens are not localized, so the line
    // holding MachineGuid parses the same on any Windows language.
    let out = std::process::Command::new("reg")
        .args(["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains("MachineGuid"))
        .and_then(|l| l.split_whitespace().last())
        .map(String::from)
}

#[cfg(target_os = "macos")]
fn mac_platform_uuid() -> Option<String> {
    // ioreg's key and quoting are not localized; the line reads
    //   "IOPlatformUUID" = "XXXXXXXX-...."
    let out = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .find(|l| l.contains("IOPlatformUUID"))
        .and_then(|l| l.split('"').nth(3))
        .map(String::from)
}

/// The first readable, non-empty machine-id among the given paths.
/// Pure over a path list so the Linux fallback order is unit-testable
/// from any OS: /etc/machine-id is systemd's home, and
/// /var/lib/dbus/machine-id is the dbus twin that minimal or older
/// systems may carry alone.
#[cfg_attr(not(all(unix, not(target_os = "macos"))), allow(dead_code))]
fn first_machine_id(paths: &[std::path::PathBuf]) -> Option<String> {
    paths.iter().find_map(|p| {
        std::fs::read_to_string(p)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    })
}

fn machine_components() -> Vec<String> {
    let mut c = vec![
        format!("os:{}", std::env::consts::OS),
        format!("arch:{}", std::env::consts::ARCH),
    ];
    #[cfg(windows)]
    if let Some(guid) = windows_machine_guid() {
        c.push(format!("guid:{guid}"));
    }
    #[cfg(target_os = "macos")]
    if let Some(uuid) = mac_platform_uuid() {
        c.push(format!("uuid:{uuid}"));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Some(id) = first_machine_id(&[
        std::path::PathBuf::from("/etc/machine-id"),
        std::path::PathBuf::from("/var/lib/dbus/machine-id"),
    ]) {
        c.push(format!("mid:{id}"));
    }
    for var in ["PROCESSOR_IDENTIFIER", "NUMBER_OF_PROCESSORS"] {
        if let Ok(v) = std::env::var(var) {
            c.push(format!("{var}:{v}"));
        }
    }
    // Note: these two are process-controlled, not machine identity. They
    // stay because the receipts already written carry digests over this
    // exact component set.
    c
}

/// Computed once per launch: on macOS the components fork `ioreg` to
/// read the platform UUID, and machine identity cannot change while the
/// process runs.
pub(crate) fn fingerprint() -> String {
    static FP: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    FP.get_or_init(|| fingerprint_of(&machine_components()))
        .clone()
}

/// Hands a URL to whatever owns its scheme on this machine (the browser
/// for https:, the mail app for mailto:).
pub(crate) fn open_with_os(url: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // `start` hands the URL to whatever owns its scheme on this
        // machine.
        //
        // The URL is quoted, and passed as ONE raw command line rather
        // than through argument escaping, because cmd reads an `&` in a
        // query string as a command separator: unquoted, everything after
        // the first `&` ran as a second command. Callers pass encoded
        // URLs, which carry no `"` to break out of the quotes.
        return std::process::Command::new("cmd")
            .raw_arg(format!("/C start \"\" \"{url}\""))
            .creation_flags(0x0800_0000)
            .spawn()
            .is_ok();
    }
    #[cfg(target_os = "macos")]
    return std::process::Command::new("open").arg(url).spawn().is_ok();
    #[cfg(all(unix, not(target_os = "macos")))]
    return std::process::Command::new("xdg-open").arg(url).spawn().is_ok();
    #[allow(unreachable_code)]
    false
}

/// Opens a web page (a release, a model's home page) in the default
/// browser. Only https, so a bad string from anywhere cannot turn into
/// a shell verb.
fn open_web_url_in(url: &str) -> Result<bool, String> {
    if !url.starts_with("https://") {
        return Err("the link must be an https URL".to_string());
    }
    Ok(open_with_os(url))
}

#[tauri::command]
pub async fn open_web_url(url: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || open_web_url_in(&url))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_web_link_is_https_or_nothing() {
        assert!(open_web_url_in("http://example.com/page").is_err());
        assert!(open_web_url_in("file:///etc/passwd").is_err());
    }

    /// The Linux identity read, exercised from any OS: the systemd
    /// file wins, the dbus twin answers when it is absent or empty,
    /// and whitespace is not an identity.
    #[test]
    fn machine_id_fallback_order_and_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        let etc = dir.path().join("machine-id");
        let dbus = dir.path().join("dbus-machine-id");
        std::fs::write(&dbus, "dbus-id\n").unwrap();
        // Only the fallback exists.
        assert_eq!(
            first_machine_id(&[etc.clone(), dbus.clone()]).as_deref(),
            Some("dbus-id")
        );
        // Both exist: the first wins.
        std::fs::write(&etc, "  systemd-id \n").unwrap();
        assert_eq!(
            first_machine_id(&[etc.clone(), dbus.clone()]).as_deref(),
            Some("systemd-id")
        );
        // An empty first file is no identity; the fallback still answers.
        std::fs::write(&etc, "\n").unwrap();
        assert_eq!(first_machine_id(&[etc.clone(), dbus]).as_deref(), Some("dbus-id"));
        // Nothing readable, nothing invented.
        assert_eq!(first_machine_id(&[etc.parent().unwrap().join("ghost")]), None);
    }

    #[test]
    fn the_fingerprint_is_stable_and_says_nothing() {
        let a = fingerprint();
        let b = fingerprint();
        assert_eq!(a, b, "same machine, same fingerprint");
        assert_eq!(a.len(), 64, "a sha256 digest, nothing raw");
        for c in machine_components() {
            let payload = c.split_once(':').map(|(_, v)| v).unwrap_or(&c);
            if payload.len() > 4 {
                assert!(!a.contains(&payload.to_lowercase()), "component leaked into fingerprint");
            }
        }
    }

    /// os: and arch: alone would make every Mac the same machine; a
    /// receipt only names this one if a hardware identity joins them.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_fingerprint_binds_to_this_mac() {
        assert!(machine_components().iter().any(|c| c.starts_with("uuid:")));
    }

    /// The digest is the one the receipts already on disk were written
    /// with: sha256 over each component and a zero byte, as hex.
    #[test]
    fn the_digest_is_the_one_the_receipts_carry() {
        let parts = ["os:macos".to_string(), "arch:aarch64".to_string()];
        assert_eq!(fingerprint_of(&parts), "60234c9834c0ab6348c684ca650a0540261129a1b80715b86e389acf44acad25");
    }

    #[test]
    fn the_machine_fingerprint_is_computed_once_per_launch() {
        let first = fingerprint();
        // Same answer, and from the cache: a thousand calls cost what
        // one costs. If this ever forks per call the wall clock says so
        // long before a user does.
        let start = std::time::Instant::now();
        for _ in 0..1000 {
            assert_eq!(fingerprint(), first);
        }
        assert!(
            start.elapsed() < std::time::Duration::from_millis(200),
            "a thousand fingerprints took {:?}; it is being recomputed",
            start.elapsed()
        );
    }
}
