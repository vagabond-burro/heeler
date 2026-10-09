//! The third-party notices page lists every crate the desktop binary
//! links. The MIT, BSD, Apache and Unicode licenses ask that their text
//! travel with a binary built from them, and the page is that
//! reproduction. A crate added to the build without regenerating the page
//! fails here, by name, so the page cannot fall behind the lock file the
//! way the earlier prose did.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the repository root")
}

/// Every external crate reachable from this binary through normal
/// dependencies on the current platform, as "name version".
fn runtime_crates() -> BTreeSet<String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    // The platform this test builds for, so the walk sees what this
    // binary links and not every target's crates (GTK, Android, the
    // GNU Windows toolchains) that the lock file also resolves.
    let rustc = Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into())).arg("-vV").output().expect("rustc runs");
    let host = String::from_utf8_lossy(&rustc.stdout)
        .lines()
        .find_map(|l| l.strip_prefix("host: ").map(str::to_string))
        .expect("rustc names its host");
    let out = Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--filter-platform", &host])
        .arg("--manifest-path")
        .arg(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
        .output()
        .expect("cargo metadata runs");
    assert!(out.status.success(), "cargo metadata failed: {}", String::from_utf8_lossy(&out.stderr));
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).expect("cargo metadata is JSON");
    let packages: std::collections::HashMap<&str, &serde_json::Value> = meta["packages"]
        .as_array()
        .expect("packages")
        .iter()
        .map(|p| (p["id"].as_str().expect("id"), p))
        .collect();
    let nodes: std::collections::HashMap<&str, &serde_json::Value> = meta["resolve"]["nodes"]
        .as_array()
        .expect("nodes")
        .iter()
        .map(|n| (n["id"].as_str().expect("id"), n))
        .collect();
    let root = meta["resolve"]["root"].as_str().expect("a root package");
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        for dep in nodes[id]["deps"].as_array().expect("deps") {
            let normal = dep["dep_kinds"]
                .as_array()
                .expect("dep_kinds")
                .iter()
                .any(|k| k["kind"].is_null() || k["kind"] == "normal");
            if normal {
                stack.push(dep["pkg"].as_str().expect("pkg"));
            }
        }
    }
    seen.into_iter()
        .filter(|id| !packages[id]["source"].is_null())
        .map(|id| format!("{} {}", packages[id]["name"].as_str().unwrap(), packages[id]["version"].as_str().unwrap()))
        .collect()
}

#[test]
fn every_linked_crate_is_on_the_notices_page() {
    let page = std::fs::read_to_string(repo_root().join("docs/user-guide/legal/third-party-notices.md"))
        .expect("docs/user-guide/legal/third-party-notices.md exists; run scripts/third_party_notices.py");
    let listed: BTreeSet<String> = page
        .lines()
        .filter_map(|l| l.strip_prefix("- "))
        .map(|l| l.split(" (").next().unwrap_or(l).split(", source").next().unwrap_or(l).trim().to_string())
        .collect();
    let crates = runtime_crates();
    assert!(crates.len() > 300, "found only {} crates, the walk is broken", crates.len());
    let missing: Vec<&String> = crates.iter().filter(|c| !listed.contains(*c)).collect();
    assert!(
        missing.is_empty(),
        "crates this binary links that the notices page does not list; run scripts/third_party_notices.py: {missing:?}"
    );
}

#[test]
fn the_notices_page_names_the_bundled_javascript() {
    let page = std::fs::read_to_string(repo_root().join("docs/user-guide/legal/third-party-notices.md")).expect("the page");
    let package: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo_root().join("apps/heeler-app/package.json")).expect("package.json")).expect("json");
    for (name, _) in package["dependencies"].as_object().expect("dependencies") {
        assert!(page.contains(&format!("### {name} ")), "{name} is bundled into the frontend but not on the notices page");
    }
}
