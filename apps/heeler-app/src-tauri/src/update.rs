//! Help > Check for Updates, and the launch-time check behind it.
//!
//! Check and link only: the app asks one fixed URL whether a newer
//! Heeler exists and, if so, offers to open the download page in the
//! browser. Nothing is downloaded or installed by the app itself; the
//! Tauri updater waits on its own signing key (milestone 8.3).
//!
//! The manifest is `latest.json` at the root of the public repo's main
//! branch, the same file the website's download button reads, served
//! raw. scripts/latest_json.py writes it from the release's attached
//! installers and stages it on the repo's dev branch; merging dev into
//! main is what makes a release live for the app and the website at
//! once, after the release itself is published (2026-09-16). Until
//! 2026.2 the app read GitHub's `releases/latest/download/latest.json`
//! redirect to the newest release's attached copy; the script still
//! attaches one for those builds. The public repo is
//! vagabond-burro/heeler (2026-09-08: the LLC's organization, not his
//! name), and its update manifest uses the format this file reads.
//! Never api.github.com: that is rate limited to sixty calls an hour
//! per address, unauthenticated; raw.githubusercontent.com is not, and
//! caches for five minutes.

use serde::Serialize;

const MANIFEST_URL: &str = "https://raw.githubusercontent.com/vagabond-burro/heeler/main/latest.json";
/// Where the button goes when the manifest names no file for this
/// machine's platform key, so the page still shows what is there.
const RELEASES_URL: &str = "https://github.com/vagabond-burro/heeler/releases/latest";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    /// A newer release exists AND it carries an installer for this
    /// platform. A newer release with nothing for this machine is not
    /// an update it can take, so it reads as up to date.
    pub available: bool,
    /// This build's version as people read it: "2026.1".
    pub current: String,
    /// The newest release's, the same way.
    pub latest: String,
    /// The installer for this platform, or the release page.
    pub url: String,
    pub notes: String,
}

/// The manifest's key for this build: Tauri's target triple, which is
/// what the updater will want later, so the manifest never changes shape.
pub(crate) fn target() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", _) => "darwin-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", _) => "windows-x86_64",
        (_, "aarch64") => "linux-aarch64",
        _ => "linux-x86_64",
    }
}

/// YY.UPDATE.PATCH as three integers, so 26.10.0 sorts after 26.9.0;
/// a string compare would put it first. A missing patch reads as zero.
fn parse_version(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().trim_start_matches('v').split('.');
    let yy = parts.next()?.parse().ok()?;
    let update = parts.next()?.parse().ok()?;
    let patch = match parts.next() {
        Some(p) => p.parse().ok()?,
        None => 0,
    };
    if parts.next().is_some() {
        return None;
    }
    Some((yy, update, patch))
}

/// What the manifest says against what this binary is. Pure, so the
/// rules live in tests rather than behind a network call.
pub(crate) fn assess(manifest: &str, own: &str, target: &str) -> Result<UpdateCheck, String> {
    let doc: serde_json::Value = serde_json::from_str(manifest).map_err(|_| "the release list could not be read".to_string())?;
    let latest_raw = doc.get("version").and_then(|v| v.as_str()).ok_or("the release list names no version")?;
    let latest = parse_version(latest_raw).ok_or_else(|| format!("the release list carries an unreadable version: {latest_raw}"))?;
    let current = parse_version(own).ok_or_else(|| format!("this build carries an unreadable version: {own}"))?;
    let platform_url = doc
        .get("platforms")
        .and_then(|p| p.get(target))
        .and_then(|p| p.get("url"))
        .and_then(|u| u.as_str())
        .filter(|u| u.starts_with("https://"))
        .map(str::to_string);
    let notes = doc.get("notes").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
    Ok(UpdateCheck {
        available: latest > current && platform_url.is_some(),
        current: crate::version::display_version_of(own),
        latest: crate::version::display_version_of(latest_raw.trim().trim_start_matches('v')),
        url: platform_url.unwrap_or_else(|| RELEASES_URL.to_string()),
        notes,
    })
}

/// Reads the release manifest and says whether this build is behind.
/// Err on any failure to fetch or read, in words the dialog can show;
/// a launch-time check shows nothing for an Err, the menu item says it.
/// Before the first release the URL is a 404, which is an Err too.
#[tauri::command]
pub async fn update_check() -> Result<UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(10)).build();
        let body = agent
            .get(MANIFEST_URL)
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => format!("could not reach the release list: HTTP {code}"),
                ureq::Error::Transport(t) => format!("could not reach the release list: {t}"),
            })?
            .into_string()
            .map_err(|e| format!("could not reach the release list: {e}"))?;
        assess(&body, env!("CARGO_PKG_VERSION"), target())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(version: &str, platforms: &[&str]) -> String {
        let plats: Vec<String> = platforms
            .iter()
            .map(|p| format!(r#""{p}": {{ "url": "https://github.com/vagabond-burro/heeler/releases/download/v{version}/Heeler-{version}-{p}.dmg", "signature": "" }}"#))
            .collect();
        format!(r#"{{ "version": "{version}", "notes": " Fixes. ", "pub_date": "2026-09-15T17:00:00Z", "platforms": {{ {} }} }}"#, plats.join(","))
    }

    #[test]
    fn a_newer_release_for_this_platform_is_offered_with_its_installer() {
        let r = assess(&manifest("26.2.0", &["darwin-aarch64"]), "26.1.0", "darwin-aarch64").unwrap();
        assert!(r.available);
        assert_eq!(r.current, "2026.1");
        assert_eq!(r.latest, "2026.2");
        assert_eq!(r.url, "https://github.com/vagabond-burro/heeler/releases/download/v26.2.0/Heeler-26.2.0-darwin-aarch64.dmg");
        assert_eq!(r.notes, "Fixes.");
    }

    #[test]
    fn the_same_or_an_older_release_reads_as_up_to_date() {
        assert!(!assess(&manifest("26.1.0", &["darwin-aarch64"]), "26.1.0", "darwin-aarch64").unwrap().available);
        assert!(!assess(&manifest("26.1.0", &["darwin-aarch64"]), "26.1.2", "darwin-aarch64").unwrap().available);
        // A patch release is newer than the release it patches.
        assert!(assess(&manifest("26.1.1", &["darwin-aarch64"]), "26.1.0", "darwin-aarch64").unwrap().available);
    }

    #[test]
    fn versions_compare_as_numbers_not_strings() {
        assert!(assess(&manifest("26.10.0", &["darwin-aarch64"]), "26.9.0", "darwin-aarch64").unwrap().available);
        assert!(!assess(&manifest("26.9.0", &["darwin-aarch64"]), "26.10.0", "darwin-aarch64").unwrap().available);
        assert!(assess(&manifest("27.1.0", &["darwin-aarch64"]), "26.12.3", "darwin-aarch64").unwrap().available);
    }

    #[test]
    fn a_release_with_nothing_for_this_platform_is_not_an_update_it_can_take() {
        let r = assess(&manifest("26.2.0", &["darwin-aarch64"]), "26.1.0", "windows-x86_64").unwrap();
        assert!(!r.available);
        assert_eq!(r.latest, "2026.2");
        assert_eq!(r.url, RELEASES_URL);
    }

    #[test]
    fn only_https_installer_links_are_followed() {
        let m = r#"{ "version": "26.2.0", "platforms": { "darwin-aarch64": { "url": "http://example.com/x.dmg" } } }"#;
        let r = assess(m, "26.1.0", "darwin-aarch64").unwrap();
        assert!(!r.available);
        assert_eq!(r.url, RELEASES_URL);
    }

    #[test]
    fn an_unreadable_manifest_is_an_error_in_words() {
        assert_eq!(assess("<html>", "26.1.0", "darwin-aarch64").unwrap_err(), "the release list could not be read");
        assert_eq!(assess("{}", "26.1.0", "darwin-aarch64").unwrap_err(), "the release list names no version");
        assert!(assess(r#"{ "version": "2026.1" }"#, "26.1.0", "darwin-aarch64").is_ok(), "a two-part version reads with patch zero");
        assert!(assess(r#"{ "version": "soon" }"#, "26.1.0", "darwin-aarch64").is_err());
        assert!(assess(r#"{ "version": "26.1.0.1" }"#, "26.1.0", "darwin-aarch64").is_err());
    }

    #[test]
    fn the_version_parser_reads_the_carried_form() {
        assert_eq!(parse_version("26.1.0"), Some((26, 1, 0)));
        assert_eq!(parse_version("v26.1.2"), Some((26, 1, 2)));
        assert_eq!(parse_version("26.1"), Some((26, 1, 0)));
        assert_eq!(parse_version("26"), None);
        assert_eq!(parse_version("26.x.0"), None);
    }

    #[test]
    fn this_build_names_a_platform_the_manifest_can_carry() {
        let t = target();
        assert!(["darwin-aarch64", "darwin-x86_64", "windows-x86_64", "windows-aarch64", "linux-x86_64", "linux-aarch64"].contains(&t));
    }

    #[test]
    fn the_manifest_url_is_the_public_repo_main_branch_and_never_the_api() {
        assert!(MANIFEST_URL.starts_with("https://raw.githubusercontent.com/vagabond-burro/heeler/main/"));
        assert!(MANIFEST_URL.ends_with("/latest.json"));
        assert!(!MANIFEST_URL.contains("api.github.com"));
        assert!(RELEASES_URL.starts_with("https://github.com/vagabond-burro/heeler/releases"));
    }
}
