//! Golden baselines shared by the bench_*_chain tests.
//!
//! A golden is a list of frame hashes over raw f32 bits. Transcendental
//! functions differ in their last bits between platform libms (macOS
//! and Windows disagree on the very first line, the zero-tool synthetic
//! passthrough, because the synthetic frame is drawn with sin and cos),
//! so a hash is only comparable on the platform that made it.
//!
//! Two kinds of baseline:
//!
//! - Per machine: the full demo-photo goldens, gitignored, bootstrapped
//! on first run on each machine.
//! - Committed: the *_small.txt synthetic goldens (2026-09-03), so
//! an op that drifts fails on every checkout. The unsuffixed file is
//! the macOS baseline, where they were first made; every other
//! platform keeps its own beside it, named by OS and architecture
//! (golden_tone_chain_small.windows-x86_64.txt), bootstrapped on its
//! first run and committed with the rest.
//!
//! A platform file carries a third column: the macOS hash each line was
//! made against. That is how the test tells a deliberate change from
//! drift (2026-09-20, when 26.3's Windows and Linux runs failed on ops
//! that had changed on purpose on the Mac): a line whose macOS hash
//! moved since this platform's file was written is accepted and the file
//! rewritten, and the run says so, so the rewritten file is committed; a
//! line whose macOS hash is the same must hash the same here too, and
//! fails if it does not. On macOS the baseline is compared as it is,
//! since that is where a change is authored and blessed.
//!
//! A missing file is written. The comparison ignores CRLF, so a checkout
//! that predates .gitattributes still reads.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub enum Baseline {
    PerMachine,
    Committed,
}

fn tests_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests")
}

/// Whether this build compares a platform file against the macOS one.
fn platform_committed(baseline: &Baseline) -> bool {
    matches!(baseline, Baseline::Committed) && !cfg!(target_os = "macos")
}

pub fn baseline_path(filename: &str, baseline: Baseline) -> PathBuf {
    let name = if platform_committed(&baseline) {
        let stem = filename.strip_suffix(".txt").unwrap_or(filename);
        format!("{stem}.{}-{}.txt", std::env::consts::OS, std::env::consts::ARCH)
    } else {
        filename.to_string()
    };
    tests_dir().join(name)
}

pub fn check_or_bootstrap(filename: &str, baseline: Baseline, lines: &[String]) {
    let platform = platform_committed(&baseline);
    let path = baseline_path(filename, baseline);
    if !platform {
        match std::fs::read_to_string(&path) {
            Ok(existing) => compare(&path, &existing, lines),
            Err(_) => {
                std::fs::write(&path, body(lines)).unwrap();
                println!("# bootstrap: wrote {}", path.display());
            }
        }
        return;
    }
    let generic_path = tests_dir().join(filename);
    let generic = std::fs::read_to_string(&generic_path)
        .unwrap_or_else(|e| panic!("the macOS baseline {} is committed and must read: {e}", generic_path.display()));
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    match std::fs::read_to_string(&path) {
        Err(_) => {
            std::fs::write(&path, stamped(lines, &generic)).unwrap();
            println!("# bootstrap: wrote {}; commit it", path.display());
        }
        Ok(existing) => match reconcile(&existing, &generic, lines) {
            Reconciled::Same => {}
            Reconciled::Rebased { body, moved } => {
                std::fs::write(&path, body).unwrap();
                println!("# rebased tests/{name} on the macOS baseline for: {}; commit it", moved.join(", "));
            }
            Reconciled::Drift(drifted) => panic!(
                "golden frames changed on this platform while the macOS baseline for them did not (drift, not a change made on purpose): {}; see tests/{name}",
                drifted.join(", ")
            ),
        },
    }
}

/// Compare against a reference the caller named. Never bootstraps or
/// overwrites: a baseline somebody asked to verify against is read-only.
pub fn check_only(path: &Path, lines: &[String]) {
    match std::fs::read_to_string(path) {
        Ok(existing) => compare(path, &existing, lines),
        Err(error) => panic!("Cannot read explicit golden {}: {error}", path.display()),
    }
}

fn body(lines: &[String]) -> String {
    lines.join("\n") + "\n"
}

fn compare(path: &Path, existing: &str, lines: &[String]) {
    assert_eq!(
        existing.replace("\r\n", "\n"),
        body(lines),
        "golden frames changed; see tests/{}",
        path.file_name().unwrap_or_default().to_string_lossy()
    );
}

/// "label words hash" into (label, hash): the hash is the last token.
fn split(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_end_matches('\r');
    let (label, hash) = line.rsplit_once(' ')?;
    Some((label, hash))
}

/// The macOS baseline's hash per label.
fn generic_hashes(generic: &str) -> BTreeMap<String, String> {
    generic.lines().filter_map(split).map(|(l, h)| (l.to_string(), h.to_string())).collect()
}

/// A platform line: the platform hash and, when the file carries it,
/// the macOS hash it was made against.
fn platform_line(line: &str) -> Option<(String, String, Option<String>)> {
    let (rest, last) = split(line)?;
    match split(rest) {
        // Three columns: label, platform hash, macOS hash.
        Some((label, platform)) if is_hash(platform) && is_hash(last) => Some((label.to_string(), platform.to_string(), Some(last.to_string()))),
        // Two columns, a file from before the stamp: label, platform hash.
        _ => Some((rest.to_string(), last.to_string(), None)),
    }
}

fn is_hash(token: &str) -> bool {
    token.len() == 16 && token.chars().all(|c| c.is_ascii_hexdigit())
}

/// The platform file's body: every current line stamped with the macOS
/// hash of the same label ("-" when macOS has no such line).
fn stamped(lines: &[String], generic: &str) -> String {
    let generic = generic_hashes(generic);
    let stamped: Vec<String> = lines
        .iter()
        .filter_map(|l| split(l).map(|(label, hash)| format!("{label} {hash} {}", generic.get(label).map(String::as_str).unwrap_or("-"))))
        .collect();
    body(&stamped)
}

pub enum Reconciled {
    Same,
    Rebased { body: String, moved: Vec<String> },
    Drift(Vec<String>),
}

/// Judge this platform's fresh hashes against its committed file, with
/// the macOS baseline as the witness to what changed on purpose.
pub fn reconcile(existing: &str, generic: &str, lines: &[String]) -> Reconciled {
    let generic_now = generic_hashes(generic);
    let recorded: BTreeMap<String, (String, Option<String>)> = existing
        .lines()
        .filter_map(platform_line)
        .map(|(label, platform, mac)| (label, (platform, mac)))
        .collect();
    let mut moved = Vec::new();
    let mut drifted = Vec::new();
    let mut current_labels = Vec::new();
    for line in lines {
        let Some((label, hash)) = split(line) else { continue };
        current_labels.push(label.to_string());
        let mac_now = generic_now.get(label).map(String::as_str).unwrap_or("-");
        match recorded.get(label) {
            None => moved.push(format!("{label} (new)")),
            Some((platform, None)) => {
                // A file from before the stamp cannot say what moved on
                // purpose; it takes the stamp now and says so.
                if platform != hash {
                    moved.push(format!("{label} (accepted unverified: the file predates the macOS stamp)"));
                } else {
                    moved.push(format!("{label} (stamped)"));
                }
            }
            Some((platform, Some(mac_then))) => {
                if mac_then != mac_now {
                    if platform != hash {
                        moved.push(label.to_string());
                    } else {
                        moved.push(format!("{label} (restamped)"));
                    }
                } else if platform != hash {
                    drifted.push(label.to_string());
                }
            }
        }
    }
    for label in recorded.keys() {
        if !current_labels.iter().any(|l| l == label) {
            moved.push(format!("{label} (dropped)"));
        }
    }
    if !drifted.is_empty() {
        return Reconciled::Drift(drifted);
    }
    if moved.is_empty() {
        return Reconciled::Same;
    }
    Reconciled::Rebased { body: stamped(lines, generic), moved }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_string).collect()
    }

    #[test]
    fn a_stamped_file_that_matches_is_left_alone() {
        let existing = "synthetic fog aaaa000000000001 1111000000000001\nsynthetic key aaaa000000000002 1111000000000002\n";
        let generic = "synthetic fog 1111000000000001\nsynthetic key 1111000000000002\n";
        assert!(matches!(reconcile(existing, generic, &lines("synthetic fog aaaa000000000001\nsynthetic key aaaa000000000002")), Reconciled::Same));
    }

    #[test]
    fn a_line_whose_macos_hash_moved_is_accepted_and_restamped() {
        let existing = "synthetic fog aaaa000000000001 1111000000000001\nsynthetic key aaaa000000000002 1111000000000002\n";
        let generic = "synthetic fog 1111000000000001\nsynthetic key 1111000000000099\n";
        match reconcile(existing, generic, &lines("synthetic fog aaaa000000000001\nsynthetic key aaaa000000000077")) {
            Reconciled::Rebased { body, moved } => {
                assert_eq!(moved, vec!["synthetic key".to_string()]);
                assert_eq!(body, "synthetic fog aaaa000000000001 1111000000000001\nsynthetic key aaaa000000000077 1111000000000099\n");
            }
            _ => panic!("a deliberate change on the Mac rebases the platform line"),
        }
    }

    #[test]
    fn a_line_whose_macos_hash_held_but_this_platform_moved_is_drift() {
        let existing = "synthetic fog aaaa000000000001 1111000000000001\nsynthetic key aaaa000000000002 1111000000000002\n";
        let generic = "synthetic fog 1111000000000001\nsynthetic key 1111000000000002\n";
        match reconcile(existing, generic, &lines("synthetic fog aaaa000000000001\nsynthetic key aaaa000000000077")) {
            Reconciled::Drift(d) => assert_eq!(d, vec!["synthetic key".to_string()]),
            _ => panic!("drift on one platform alone must fail"),
        }
    }

    #[test]
    fn drift_is_reported_even_beside_a_deliberate_change() {
        let existing = "synthetic fog aaaa000000000001 1111000000000001\nsynthetic key aaaa000000000002 1111000000000002\n";
        let generic = "synthetic fog 1111000000000001\nsynthetic key 1111000000000099\n";
        match reconcile(existing, generic, &lines("synthetic fog aaaa000000000055\nsynthetic key aaaa000000000077")) {
            Reconciled::Drift(d) => assert_eq!(d, vec!["synthetic fog".to_string()]),
            _ => panic!("the fog line moved with no change on the Mac"),
        }
    }

    #[test]
    fn a_file_from_before_the_stamp_takes_it_and_says_what_it_could_not_check() {
        let existing = "synthetic fog aaaa000000000001\nsynthetic key aaaa000000000002\n";
        let generic = "synthetic fog 1111000000000001\nsynthetic key 1111000000000002\n";
        match reconcile(existing, generic, &lines("synthetic fog aaaa000000000001\nsynthetic key aaaa000000000077")) {
            Reconciled::Rebased { body, moved } => {
                assert_eq!(moved, vec!["synthetic fog (stamped)".to_string(), "synthetic key (accepted unverified: the file predates the macOS stamp)".to_string()]);
                assert_eq!(body, "synthetic fog aaaa000000000001 1111000000000001\nsynthetic key aaaa000000000077 1111000000000002\n");
            }
            _ => panic!("a legacy file is stamped"),
        }
    }

    #[test]
    fn new_and_dropped_lines_rebase_and_crlf_reads() {
        let existing = "synthetic fog aaaa000000000001 1111000000000001\r\nsynthetic old aaaa000000000002 1111000000000002\r\n";
        let generic = "synthetic fog 1111000000000001\nsynthetic new 1111000000000003\n";
        match reconcile(existing, generic, &lines("synthetic fog aaaa000000000001\nsynthetic new aaaa000000000003")) {
            Reconciled::Rebased { body, moved } => {
                assert_eq!(moved, vec!["synthetic new (new)".to_string(), "synthetic old (dropped)".to_string()]);
                assert_eq!(body, "synthetic fog aaaa000000000001 1111000000000001\nsynthetic new aaaa000000000003 1111000000000003\n");
            }
            _ => panic!("new and dropped lines rewrite the file"),
        }
    }
}
