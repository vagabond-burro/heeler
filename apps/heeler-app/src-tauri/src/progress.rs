//! The one progress-and-cancel mechanism for the long operations: an
//! event `heeler:progress` with {op, id, done, total, message}, and a
//! cancel registry keyed by `id` that the worker polls between units. The
//! frontend renders one progress row with a Cancel button from the event.
//! Image jobs can attach presentation data for their existing canvas or
//! dialog.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

pub const PROGRESS_EVENT: &str = "heeler:progress";

#[derive(Clone, Debug, Serialize)]
pub struct ProgressEvent {
    pub op: String,
    pub id: String,
    pub done: u64,
    pub total: u64,
    pub message: String,
}

static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Default)]
struct CancelState {
    active: HashSet<String>,
    cancelled: HashSet<String>,
}
static CANCELS: OnceLock<Mutex<CancelState>> = OnceLock::new();
static LAST_EMIT: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

/// How often one operation's row is repainted at most. The sweeps
/// report per file and a relink per photograph; a few thousand events
/// in a burst would cross the IPC and re-render the row for each one,
/// which is its own small stall. The last report (done at total)
/// always goes out.
pub const EMIT_EVERY: Duration = Duration::from_millis(100);

fn cancels() -> &'static Mutex<CancelState> {
    CANCELS.get_or_init(Default::default)
}

fn last_emit() -> &'static Mutex<HashMap<String, Instant>> {
    LAST_EMIT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether a report for `id` goes out now: the first one, one at or
/// past the total, or one at least EMIT_EVERY after the last that did.
/// Records the send when it answers true.
fn due(id: &str, done: u64, total: u64) -> bool {
    let now = Instant::now();
    let mut last = last_emit().lock().unwrap();
    let go = match last.get(id) {
        None => true,
        Some(at) => (total > 0 && done >= total) || now.duration_since(*at) >= EMIT_EVERY,
    };
    if go {
        last.insert(id.to_string(), now);
    }
    go
}

/// Mints the id an operation's events and its cancel share. Ids are
/// unique within the run, which is all the registry asks of them.
pub fn begin(op: &str) -> String {
    let id = format!("{op}-{}", NEXT.fetch_add(1, Ordering::Relaxed));
    cancels().lock().unwrap().active.insert(id.clone());
    id
}

/// Marks an operation canceled. The worker notices between units;
/// nothing is interrupted from here directly.
pub fn cancel(id: &str) {
    let mut state = cancels().lock().unwrap();
    if state.active.contains(id) {
        state.cancelled.insert(id.to_string());
    }
}

pub fn is_cancelled(id: &str) -> bool {
    cancels().lock().unwrap().cancelled.contains(id)
}

/// Drops the id when the operation is over either way, so the registry
/// cannot grow across a session of backups and clears.
pub fn finish(id: &str) {
    {
        let mut state = cancels().lock().unwrap();
        state.active.remove(id);
        state.cancelled.remove(id);
    }
    last_emit().lock().unwrap().remove(id);
}

pub struct Completion(String);

impl Drop for Completion {
    fn drop(&mut self) {
        finish(&self.0);
    }
}

pub fn finish_on_drop(id: &str) -> Completion {
    Completion(id.to_string())
}

/// Reports a unit of work. A lost event is fine (the row is a courtesy,
/// not state), so a closed window's error is dropped. Reports come at
/// most every EMIT_EVERY per id, except the first and the last.
pub fn emit(app: &tauri::AppHandle, op: &str, id: &str, done: u64, total: u64, message: impl Into<String>) {
    if !due(id, done, total) {
        return;
    }
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressEvent {
            op: op.to_string(),
            id: id.to_string(),
            done,
            total,
            message: message.into(),
        },
    );
}

/// Extra presentation data uses the same channel and operation identity.
/// Ordinary rows keep their existing payload and specialized views adapt
/// this envelope at the bridge.
#[derive(Serialize, Clone)]
struct DetailedProgress<'a, T: Serialize + Clone> {
    #[serde(flatten)]
    progress: ProgressEvent,
    detail: &'a T,
}

pub fn emit_detail<T: Serialize + Clone>(app: &tauri::AppHandle, op: &str, id: &str, done: u64, total: u64, message: impl Into<String>, detail: &T) {
    let _ = app.emit(PROGRESS_EVENT, DetailedProgress {
        progress: ProgressEvent { op: op.into(), id: id.into(), done, total, message: message.into() },
        detail,
    });
}

/// 12 MB, 700 KB, 340 B: the words the progress row puts on byte counts.
pub fn human_bytes(n: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if n >= GB {
        format!("{:.1} GB", n as f64 / GB as f64)
    } else if n >= MB {
        format!("{} MB", n / MB)
    } else if n >= KB {
        format!("{} KB", n / KB)
    } else {
        format!("{n} B")
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_worker_completion_releases_its_own_id_when_it_unwinds() {
        let id = super::begin("test-completion-unwind");
        let completion = super::finish_on_drop(&id);
        let watched = id.clone();
        assert!(super::cancels().lock().unwrap().active.contains(&id));
        let worker = std::thread::spawn(move || {
            let _completion = completion;
            super::cancel(&watched);
            assert!(super::is_cancelled(&watched));
            panic!("test worker panic");
        });
        assert!(worker.join().is_err());
        assert!(!super::cancels().lock().unwrap().active.contains(&id));
        assert!(!super::is_cancelled(&id));
    }

    #[test]
    fn workers_keep_a_completion_guard_for_error_and_panic_paths() {
        let source = include_str!("lib.rs");
        for name in ["polish_matte_full", "relink_folder", "clear_proxies", "clear_smart_rasters", "backup_catalog", "restore_catalog", "move_catalog", "import_catalog", "watched_stack_merge"] {
            let signature = format!("fn {name}(");
            let start = source.find(&signature).unwrap();
            let body = source[start..].split("
}").next().unwrap();
            let begin = body.find("progress::begin(").unwrap();
            assert!(body[begin..].contains("progress::finish_on_drop("), "{name} must release its own operation on every exit");
        }
    }

    #[test]
    fn a_late_cancel_cannot_revive_a_finished_operation() {
        let id = super::begin("test-late-cancel");
        super::finish(&id);
        super::cancel(&id);
        assert!(!super::is_cancelled(&id));
        let unknown = format!("{id}-unknown");
        super::cancel(&unknown);
        assert!(!super::is_cancelled(&unknown));
    }

    #[test]
    fn a_cancelled_id_reads_cancelled_until_finished() {
        let id = super::begin("backup");
        assert!(!super::is_cancelled(&id));
        super::cancel(&id);
        assert!(super::is_cancelled(&id));
        super::finish(&id);
        assert!(!super::is_cancelled(&id));
        // A later id of the same op is its own operation.
        let next = super::begin("backup");
        assert_ne!(id, next);
        assert!(!super::is_cancelled(&next));
        super::finish(&next);
    }

    /// A burst of per-file reports goes out as one every EMIT_EVERY:
    /// the first at once, the rest held, and the one at the total always.
    #[test]
    fn reports_are_throttled_per_id_and_the_last_always_goes_out() {
        let id = super::begin("proxies");
        assert!(super::due(&id, 1, 100), "the first report goes out");
        assert!(!super::due(&id, 2, 100), "the next one inside the window is held");
        assert!(!super::due(&id, 50, 100));
        assert!(super::due(&id, 100, 100), "the report at the total goes out regardless");
        std::thread::sleep(super::EMIT_EVERY + std::time::Duration::from_millis(5));
        assert!(super::due(&id, 3, 0), "after the window a report goes out, total unknown or not");
        // Another operation keeps its own clock.
        let other = super::begin("rasters");
        assert!(super::due(&other, 1, 10));
        super::finish(&id);
        super::finish(&other);
        assert!(super::due(&id, 1, 100), "finish forgets the clock along with the cancel");
        super::finish(&id);
    }

    #[test]
    fn human_bytes_picks_the_unit_a_person_reads() {
        assert_eq!(super::human_bytes(340), "340 B");
        assert_eq!(super::human_bytes(700 * 1024), "700 KB");
        assert_eq!(super::human_bytes(48 * 1024 * 1024), "48 MB");
        assert_eq!(super::human_bytes(3 * 1024 * 1024 * 1024 + 536_870_912), "3.5 GB");
    }
}
