//! The installers show the license as plain text (apps/heeler-app/src-tauri/
//! license.txt) and the guide its legal/license.md, both copied from the
//! repository's LICENSE by
//! scripts/license_text.py: Tauri hands one license file to every bundle.
//! A change to LICENSE without regenerating the copy fails here, so the
//! installers never show a license other than the one the source carries.

use std::path::PathBuf;
use std::process::Command;

#[test]
fn the_installer_license_is_the_repository_license() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().expect("the repository root");
    let python = std::env::var("PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
    let script = root.join("scripts/license_text.py");
    let out = match Command::new(&python).arg(&script).arg("--check").output() {
        // pyenv-win puts python on PATH as a .bat shim, which a process
        // spawn cannot start; cmd resolves the shim.
        Err(e) if cfg!(windows) && e.kind() == std::io::ErrorKind::NotFound => Command::new("cmd")
            .arg("/C")
            .arg(&python)
            .arg(&script)
            .arg("--check")
            .output()
            .expect("cmd runs python for the license check"),
        other => other.expect("python runs the license check"),
    };
    assert!(
        out.status.success(),
        "license.txt is stale or unreadable:\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let conf = std::fs::read_to_string(root.join("apps/heeler-app/src-tauri/tauri.conf.json")).unwrap();
    assert!(conf.contains("\"licenseFile\": \"license.txt\""), "tauri.conf.json hands the installers license.txt");
    let text = std::fs::read_to_string(root.join("apps/heeler-app/src-tauri/license.txt")).unwrap();
    assert!(text.starts_with("Mozilla Public License Version 2.0"), "the installers show the MPL");
    assert!(text.is_ascii(), "the disk image's license pane reads the file as MacRoman; ASCII decodes the same either way");
    // And the guide's copy, which Help > Legal Documents opens.
    let page = std::fs::read_to_string(root.join("docs").join("user-guide/legal/license.md")).unwrap();
    let (title, rest) = text.split_once("\n").unwrap();
    let rest = rest.split_once("\n").unwrap().1;
    assert_eq!(page, format!("# {title}\n{rest}"), "the guide's license page is the license, its title a chapter heading");
}
