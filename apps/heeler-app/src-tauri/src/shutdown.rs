//! Quitting, in an order WebView2 can follow.
//!
//! On Windows every quit printed "Failed to unregister class
//! Chrome_WidgetWin_0. Error = 1412" (2026-10-07). 1412 is
//! ERROR_CLASS_HAS_WINDOWS: WebView2's own cleanup, running as the
//! process ends, found windows of its class still alive. `app.exit(0)`
//! sets the event loop to end, and tao's Windows loop then calls
//! `process::exit` at once, with any pop-out still open and WebView2
//! still taking down the windows behind each page. Release builds have
//! no console, so nobody but a dev run ever saw it, but it is a process
//! ending in the middle of its webviews' teardown.
//!
//! So on Windows the app ends in order: every window is destroyed
//! through the event loop, which keeps pumping messages while WebView2
//! finishes, and only then does the app exit. The loop would end on
//! its own as the last window goes (an exit request with no code); that
//! one is held while the shutdown runs. Elsewhere `exit_app` exits at
//! once, as it always has.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::Manager as _;

/// Set when the orderly shutdown starts; never cleared, the app is
/// going.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

/// How long the windows get to be gone before the app exits anyway: a
/// shutdown must never become a hang.
const WINDOWS_GONE_WITHIN: Duration = Duration::from_secs(2);

/// The event loop's time to finish WebView2's teardown once the last
/// window is gone, before the process ends.
const WEBVIEW2_TEARDOWN: Duration = Duration::from_millis(300);

pub fn shutting_down() -> bool {
    SHUTTING_DOWN.load(Ordering::SeqCst)
}

/// Whether an exit request is held: only the loop's own (no code, the
/// last window gone) during the orderly shutdown, which ends with an
/// exit of its own (code 0) that goes through.
pub fn hold_exit(shutting_down: bool, code: Option<i32>) -> bool {
    shutting_down && code.is_none()
}

/// Ends the app. Callers close the catalog first.
pub fn exit_app(app: &tauri::AppHandle) {
    if !cfg!(windows) {
        app.exit(0);
        return;
    }
    if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    // Off the event loop's thread: destroying a window from inside a
    // window-event callback blocks the loop that has to service it
    // (the hang the main window's close handler records).
    std::thread::spawn(move || {
        for window in app.webview_windows().into_values() {
            let _ = window.destroy();
        }
        let deadline = Instant::now() + WINDOWS_GONE_WITHIN;
        while !app.webview_windows().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(WEBVIEW2_TEARDOWN);
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::hold_exit;

    #[test]
    fn only_the_loops_own_exit_is_held_and_only_while_shutting_down() {
        // The last window going asks with no code: held during the
        // shutdown, so the loop keeps pumping for WebView2.
        assert!(hold_exit(true, None));
        // The shutdown's own exit, and any explicit exit, go through.
        assert!(!hold_exit(true, Some(0)));
        // Outside a shutdown nothing is held: closing the last window
        // still ends the app the way it always did.
        assert!(!hold_exit(false, None));
        assert!(!hold_exit(false, Some(0)));
    }
}
