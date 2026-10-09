//! The Python console: a persistent interpreter under the Console
//! panel, speaking the same bridge as any external script.
//!
//! The design keeps one honest path: the console does not get a private
//! way into the app. Its interpreter is the system Python running a
//! tiny driver, with the bridge's port and token in its environment, so
//! `h = heeler.connect()` inside the console is EXACTLY the client an
//! external script uses: same commands, same validation, same undo.
//!
//! The driver protocol is JSON lines: one request in, one reply out,
//! stdout/stderr captured per request, the namespace persistent across
//! them, which is what makes it a REPL rather than a runner.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// The client, embedded so the console needs no install-path lookup.
/// Batch mode (batch.rs) ships the same pair, which is the point: one
/// client everywhere.
pub(crate) const CLIENT_PY: &str = include_str!("../../../../tools/python/heeler.py");
/// The REPL driver: reads JSON lines, execs in one namespace, answers.
pub(crate) const DRIVER_PY: &str = include_str!("../../../../tools/python/driver.py");

struct Repl {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<String>,
    _tx: Sender<String>,
}

fn repl() -> &'static Mutex<Option<Repl>> {
    static R: OnceLock<Mutex<Option<Repl>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

#[derive(Serialize)]
pub struct PyResult {
    pub out: String,
    pub err: String,
    pub value: Option<String>,
}

/// `python` on Windows; on unix, whichever of python3/python answers.
/// macOS ships only `python3`.
pub(crate) fn python_command() -> Command {
    #[cfg(windows)]
    return Command::new("python");
    #[cfg(not(windows))]
    {
        use std::sync::OnceLock;
        static NAME: OnceLock<&'static str> = OnceLock::new();
        let name = NAME.get_or_init(|| {
            for cand in ["python3", "python"] {
                if Command::new(cand).arg("--version").output().is_ok() {
                    return cand;
                }
            }
            // Spawning will fail either way; the error names python3.
            "python3"
        });
        Command::new(*name)
    }
}

fn start_repl(app: &tauri::AppHandle) -> Result<Repl, String> {
    // The console talks through the bridge, so the bridge must be up.
    // Started here rather than demanded of the user: opening a Python
    // console IS opting into scripting.
    let status = crate::api::ensure_started(app)?;

    let dir = std::env::temp_dir().join("heeler-py");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("heeler.py"), CLIENT_PY).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("driver.py"), DRIVER_PY).map_err(|e| e.to_string())?;

    let mut cmd = python_command();
    cmd.arg("-u")
        .arg(dir.join("driver.py"))
        .current_dir(&dir)
        .env("HEELER_API_PORT", status.port.to_string())
        .env("HEELER_API_TOKEN", &status.token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console window flashing behind the app.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| {
        format!("could not start python: {e}. Python 3 must be installed and on PATH (as python or python3).")
    })?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    // A reader thread hands lines over a channel so requests can time
    // out rather than hanging the app on a wedged interpreter.
    let (tx, rx) = channel();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if tx2.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    Ok(Repl { child, stdin, lines: rx, _tx: tx })
}

fn request(app: &tauri::AppHandle, req: serde_json::Value) -> Result<PyResult, String> {
    let mut guard = repl().lock().map_err(|_| "console lock poisoned")?;
    if guard.is_none() {
        *guard = Some(start_repl(app)?);
    }
    let r = guard.as_mut().expect("just started");
    let line = format!("{req}\n");
    if r.stdin.write_all(line.as_bytes()).is_err() {
        // The interpreter died; a fresh one picks up next time.
        *guard = None;
        return Err("the Python session ended; run again to start a new one".into());
    }
    let _ = r.stdin.flush();
    let reply = r
        .lines
        .recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "Python did not answer (still running? blocked?)".to_string())?;
    let v: serde_json::Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    Ok(PyResult {
        out: v.get("out").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        err: v.get("err").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        value: v.get("value").and_then(|x| x.as_str()).map(String::from),
    })
}

// Async on purpose, all three: a sync command runs on the main thread,
// and a console line like h.ping() would then deadlock the app. Python
// waits on the bridge, the bridge waits on the webview, the webview
// waits on the main thread, and the main thread is us, waiting on
// Python. Async commands run off the main thread and the loop closes.

#[tauri::command]
pub async fn py_exec(app: tauri::AppHandle, code: String) -> Result<PyResult, String> {
    request(&app, serde_json::json!({ "op": "exec", "code": code }))
}

#[tauri::command]
pub async fn py_run_file(app: tauri::AppHandle, path: String) -> Result<PyResult, String> {
    request(&app, serde_json::json!({ "op": "run", "path": path }))
}

#[tauri::command]
pub async fn py_reset() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut guard = repl().lock().map_err(|_| "console lock poisoned")?;
        if let Some(mut r) = guard.take() {
            let _ = r.child.kill();
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pick a script to open: .heeler is the house extension, plain .py
/// welcome too.
#[tauri::command]
pub async fn pick_script(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    match app
        .dialog()
        .file()
        .add_filter("Heeler scripts", &["heeler", "py"])
        .blocking_pick_file()
    {
        Some(fp) => Ok(Some(
            fp.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string(),
        )),
        None => Ok(None),
    }
}

/// Where to save a scratchboard tab that has no file yet.
#[tauri::command]
pub async fn pick_script_save(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    match app
        .dialog()
        .file()
        .add_filter("Heeler scripts", &["heeler", "py"])
        .set_file_name("script.heeler")
        .blocking_save_file()
    {
        Some(fp) => Ok(Some(
            fp.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string(),
        )),
        None => Ok(None),
    }
}

/// The scratchboard's file half: tabs open from disk and save back to
/// it. Paths only ever come from the two dialogs above.
#[tauri::command]
pub async fn read_script(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read_to_string(&path).map_err(|e| format!("could not read {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn write_script(path: String, text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, text).map_err(|e| format!("could not write {path}: {e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The driver protocol, against the real interpreter. Skipped
    /// quietly on machines without Python; everywhere else it proves
    /// the whole loop: persistent namespace, expression values, stdout
    /// capture, and errors as text rather than a dead session.
    #[test]
    fn the_driver_speaks_the_protocol() {
        let dir = std::env::temp_dir().join("heeler-py-test");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("driver.py"), DRIVER_PY).unwrap();
        std::fs::write(dir.join("heeler.py"), CLIENT_PY).unwrap();
        let spawned = python_command()
            .arg("-u")
            .arg(dir.join("driver.py"))
            .current_dir(&dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = spawned else {
            eprintln!("python not on PATH; skipping");
            return;
        };
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut ask = |req: serde_json::Value| -> serde_json::Value {
            writeln!(stdin, "{req}").unwrap();
            serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap()
        };
        // An expression answers with its value.
        let r = ask(serde_json::json!({ "op": "exec", "code": "1 + 1" }));
        assert_eq!(r["value"], "2");
        // The namespace persists across requests.
        ask(serde_json::json!({ "op": "exec", "code": "x = 21" }));
        let r = ask(serde_json::json!({ "op": "exec", "code": "x * 2" }));
        assert_eq!(r["value"], "42");
        // Stdout is captured, not lost.
        let r = ask(serde_json::json!({ "op": "exec", "code": "print('hail')" }));
        assert_eq!(r["out"], "hail\n");
        // An error is a message, not a dead interpreter.
        let r = ask(serde_json::json!({ "op": "exec", "code": "boom" }));
        assert!(r["err"].as_str().unwrap().contains("NameError"));
        let r = ask(serde_json::json!({ "op": "exec", "code": "x" }));
        assert_eq!(r["value"], "21");
        // The scratchboard contract: a block runs whole, and the last
        // expression answers. The owner writes a function and calls it in one
        // selection; the call's value must come back.
        let r = ask(serde_json::json!({
            "op": "exec",
            "code": "def dbl(v):\n    return v * 2\ndbl(x)"
        }));
        assert_eq!(r["value"], "42");
        assert_eq!(r["err"], "");
        let _ = child.kill();
    }
}
