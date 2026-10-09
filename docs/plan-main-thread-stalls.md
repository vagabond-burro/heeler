# Plan: synchronous Tauri commands block the UI thread

Status: decided 2026-09-19 (the catalog lock split). Written 2026-09-19 against v26.3 at a58d5a0d. Supersedes the follow-up
section of `docs/reviews/2026-09-12-file-menu-stall-notes.md` (in git history at 8aad7f31), which diagnosed the problem,
fixed two commands, and left the rest ranked but unaddressed.

## What an agent needs to know first

Tauri v2 runs a command declared as a bare `fn` **on the main thread**. While it runs, the
webview cannot paint and no click is dispatched. A command that touches the filesystem, a
SQLite catalog or a mutex can therefore freeze the entire application for as long as that
operation takes, and the control the user was clicking has nothing to do with the command
that blocked them.

This is not theoretical. On 2026-09-12 the owner reported the File menu locking up with a
spinning cursor. The File menu was a bystander: the 15-second background folder watcher
called `list_subfolders`, a bare `fn`, which enumerated an exfat volume that had not
returned after 80 seconds in a measured probe. Any click landing in that window beachballed.

That specific path was fixed. The class was not.

## Current measured state

Counted at a58d5a0d by the script at the end of this document.

| | Count |
|---|---:|
| Tauri commands | 212 |
| Declared `async fn` | 116 |
| Declared bare `fn` | 96 |
| Bare `fn` that touch I/O, the catalog or a lock | **72** |

Of the 69 commands the 2026-09-12 audit flagged, **67 are still synchronous**. The two that
were converted are `list_subfolders` and `recent_catalogs`.

Since that audit the app grew by roughly 45 commands and added 14 new synchronous ones that
touch I/O. So the rule written down at the time ("a new command that touches the filesystem,
the catalog or a lock is `async fn` with `spawn_blocking`, never a bare `fn`") has been
mostly followed for new work, but it has leaked, and nothing enforces it.

The 72 break down as:

- **52** enter the catalog or the session (`with_catalog` / `with_session`)
- **19** do filesystem or process work without the session
- **1** takes another lock only

The automated detector is a lower bound: it matches source patterns, so a thin wrapper whose
body does not literally name them is missed. Treat 72 as a floor, and the hand-audited list
in the 2026-09-12 notes as the authority on anything ambiguous.

### Lock timing evidence

Both lock kinds report through `debug_log!`: any wait over 50 ms to acquire and any hold
over 50 ms, naming the caller. A desktop test run (`cargo test -p heeler-desktop lock_timing
-- --nocapture`) shows the two line shapes, from the tests' own injected slow closure and
two-thread wait:

```
lock: session held 100ms at apps/heeler-app/src-tauri/src/lib.rs:19153:13
lock: catalog waited 97ms at apps/heeler-app/src-tauri/src/lib.rs:19197:17
```

Those two lines come from synthetic contention. The real evidence is a day of ordinary
use: turn debug logging on (Preferences), work for a day, then read what the locks said:

```
grep "lock:" ~/Library/Application\ Support/com.vagabondburro.heeler/heeler-console.log
```

Every line names the lock (session or catalog), whether it waited or held, for how long,
and the caller's source location. A command that shows up holding the session lock across
tens of milliseconds is the next conversion candidate; a lock that never appears is a lock
the reader-pool decision does not need to worry about.


## Two distinct problems, and only one is cheap

**Problem A: the work runs on the main thread.** Any bare `fn` command doing I/O can freeze
the UI. The fix is mechanical: make it `async fn` and move the blocking work into
`tokio::task::spawn_blocking`. Low risk, high volume, well-precedented in this codebase.

**Problem B: the Session mutex is held across I/O.** `with_catalog` enters `with_session`,
and that mutex stays held for the whole closure. Catalog backup, import, move, relinking,
collection loading and catalog writes can all hold it while doing disk work. Converting
those to async fixes the main thread but does **not** fix the serialization: every other
catalog command still queues behind the holder, so the UI stays responsive while the app
stops doing anything useful.

Problem A can be swept. Problem B needs a design decision from the owner before anyone
writes code. Do not let an agent invent an answer to B while doing A.

## Recommended solution

### For Problem A, the pattern

```rust
// Before: runs on the main thread.
#[tauri::command]
fn thing(state: tauri::State<'_, SessionState>, path: String) -> Result<Payload, String> {
    with_catalog(&state, |cat| cat.query(&path))
}

// After: dispatched, blocking work on the pool.
#[tauri::command]
async fn thing(state: tauri::State<'_, SessionState>, path: String) -> Result<Payload, String> {
    let handle = state.inner().clone();            // owned, Send
    tokio::task::spawn_blocking(move || {
        with_catalog(&handle, |cat| cat.query(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}
```

Three constraints that will bite:

1. **No guard may cross an `.await`.** A `MutexGuard` is not `Send`. Take what you need,
   clone it, and move owned values into the closure. If a command currently returns a
   borrow of session state, it needs restructuring, not just an `async` keyword.
2. **`tauri::State` cannot be moved into `spawn_blocking`.** Clone the inner `Arc` first, as
   above. This is the single most common way this conversion fails to compile.
3. **The frontend does not change.** `invoke` is already promise-based on the TypeScript
   side, so converting a command to async is invisible to callers. Do not touch `bridge.ts`
   for this work. If a conversion seems to require a frontend change, something else is wrong.

### For Problem A, what NOT to convert

- `set_maximize_button_rect` is deliberately synchronous because it does window-thread work.
  The 2026-09-12 audit excluded it on purpose. Leave it.
- `denoise_tiles` and `brush_tip_preview` are CPU helpers, not I/O. They may deserve input
  bounds, but that is a separate concern and out of scope here.
- `build_info`, `set_log_level`, `console_log_file` (resolves a path only): trivial, leave them.

### For Problem B, the decision (2026-09-19: "Agreed")

What the code says first. `SessionState` is one `Mutex<Session>` around
everything: the catalog connection, both decoded image caches, the
executor, the tether watch, the camera, and the SAM, matting and inpaint
models. So a catalog query waits behind render preparation and a render
waits behind a backup. "Hold the mutex only long enough to obtain a
connection" has nothing to obtain: the connection lives inside the
Session. Taking the catalog out (the executor's `std::mem::take` pattern)
leaves `None` behind, and the next `with_catalog` would open a SECOND
connection, which is the exFAT stale-snapshot case the catalog crate
documents beside its `PRAGMA journal_mode = WAL` line. A connection pool
hits the same wall: concurrent WAL readers need the shared-memory index to
be coherent, and FSKit does not keep it coherent on exFAT.

Decision: **the catalog gets its own lock, separate from the Session, and
keeps one connection.**

- A second managed state, `CatalogState = Mutex<Option<Catalog>>`, plus
  the `upgrade_approved` set that belongs with it. `with_catalog` takes
  ONLY that lock and never enters `with_session`.
- A command that needs both copies what it needs out of the Session
  first (paths, ids, settings), releases it, then takes the catalog.
  Never both at once. A source-shape test asserts no function body holds
  a `with_session` closure that calls `with_catalog` or the reverse.
- Two catalog commands still serialize on the one connection. That is
  what a catalog-based RAW editor does too; its responsiveness comes from nothing running
  on the UI thread, catalog work never blocking rendering, progress on
  long operations, and cached reads. The split gives the first two; the
  sweep gives the first; progress is its own phase below.
- A reader pool (option 2) stays a measured decision after the split,
  gated on the catalog's filesystem: allowed on APFS and NTFS, never on
  exFAT or a network mount.

Two additions that come before any conversion:

- **The enforcement test first.** A test in the Tauri crate scans the
  source for `#[tauri::command]` followed by a bare `fn` whose body
  matches the I/O, catalog or lock patterns, and fails unless the name
  is on an allowlist. The allowlist starts as today's 72 and may only
  shrink; the test also fails if a name on the allowlist no longer
  matches (so the list cannot rot). Each sweep commit removes names and
  makes it green. The list is the work order.
- **Lock timing in the debug log.** `with_session` and `with_catalog`
  log, through `debug_log!`, any wait over 50 ms to acquire and any hold
  over 50 ms, with the command name. That is the evidence a reader pool
  decision needs.

One trap the earlier text did not name: synchronous commands ran in call
order, async ones interleave. The frontend's save barrier
(`savebarrier.ts`) covers the saves; keep the three unprompted saves
behind it, and list any command pair the frontend fires without awaiting
as it is found. Found and fixed (2026-09-19): the two
`void saveSession(...)` navigation calls in `ui/chrome.tsx` bypassed the
barrier, so an older navigation's record could land after a newer one;
both now arm `catalogSaves` like the other saves, with a test that
navigates twice while the first save's promise is unresolved.

## Phased work plan

Each phase is independently landable and independently testable. Order:
Phase 0 (scanner test and lock timing), Phase 1, Phase 2a (the catalog
lock split, structural, no async changes), Phase 2b (the catalog commands
to async in batches of about ten), Phase 3, Phase 4, then progress and
cancel on backup, import, move, relink and clear operations, then the
measured reader-pool decision.

### Phase 1: background and unprompted work (highest urgency, smallest diff)

These run without the user asking, so they can freeze an unrelated click. This is the exact
shape of the bug already reported and fixed once.

- `run_scheduled_backup` (lib.rs:9950): Session
- `save_ui_graph` (lib.rs:10892): Session
- `save_ui_session` (lib.rs:7709): Session

Three commands. Do this first; it is a couple of hours and removes the reproduced failure mode.

### Phase 2: bulk catalog and disk operations

Long by data size, file count or SQLite work, and most hold the Session mutex while doing it.
This is the phase that needs the Problem B decision, because converting them to async without
shortening the critical section moves the freeze rather than removing it.

`backup_catalog`, `move_catalog`, `import_catalog`, `open_catalog`, `create_catalog`,
`catalog_upgrade_check`, `catalog_upgrade_approve`, `relink_folder`, `relink_image`,
`missing_images`, `move_images_to_trash`, `restore_images_from_trash`, `trash_in_folder`,
`storage_info`, `clear_thumbnails`, `clear_proxies`, `clear_smart_rasters`, `load_collection`,
`catalog_folder_images`, `catalog_images`, `catalog_info`, `hide_folder`, `flush_folder`,
`recover_hidden`, `serve_cache_dir`

### Phase 3: path checks, reveals, reads, process and network setup

Filesystem latency dominates even a small request, and several shell out.

`reveal_folder`, `reveal_file`, `reveal_trash`, `reveal_models`, `reveal_proxies`,
`reveal_smart_rasters`, `lens_profile_for`, `lut_info`, `load_ui_graph`,
`load_last_good_graph`, `reset_image_edits`, `set_image_keywords`, `serve_start`,
`write_gallery`, `set_catalog_upgrade_policy`, `read_script` (py.rs), `write_script` (py.rs),
`agreement_receipt`, `agreement_accept`, `entitlement_read`, `entitlement_write`,
`license_status`, `license_request`, `license_install`

### Phase 4: small catalog queries and short locks

Individually fast, but they queue behind any long Session holder, and `with_catalog` can open
or migrate the database on first use.

`list_folders`, `last_session_folder`, `edited_folders`, `folder_session`, `load_ui_session`,
`clear_thumbnail`, `list_collections`, `create_collection`, `rename_collection`,
`delete_collection`, `add_to_collection`, `remove_from_collection`, `folder_subtree_counts`,
`hidden_in_folder`, `trashed_images`, `folders_with_hidden`, `folders_with_trash`,
`catalog_summary`, `set_image_rating`, `set_image_link_group`, `set_image_flag`,
`image_keywords`, `all_keywords`, `keyword_images`, `api_respond`, `api_stop`,
`serve_stop`, `serve_status`

### Phase 5: async commands that block the runtime's workers (review, 2026-09-19)

Found while reviewing Phase 3 and 4: 49 commands were declared `async fn`
before the plan and still do their blocking work inline, on the async
runtime's worker threads, with no `spawn_blocking`. An async command
never freezes the UI, but the runtime has one worker per core, and a
decode, a disk walk or a USB wait holds one for as long as it runs:
enough of them at once and every other async command waits behind
them, saves included, while the window stays responsive. The test
`every_async_command_moves_its_blocking_work_off_the_runtime` names
them on `ASYNC_INLINE` and the list can only shrink.

Order, by how long one call can hold a worker:

1. The tether and USB camera commands (fifteen, `tether_*` and
   `usb_camera_*`): a PTP wait can be seconds; one stuck camera can
   hold a worker for the length of a capture.
2. The heavy renders and decodes: `load_thumbnail`, `render_thumbnail`,
   `render_pane`, `export_to`, `export_image`, `bake_composite`,
   `create_pano` and the stack siblings (`create_stack`,
   `stack_*`, `update_pano`, `pano_info`), `region_select`,
   `depth_at`, `smart_raster_status`, `depth_forget`.
3. The small file reads and writes: presets, UI settings, docs,
   metadata, the console log, `serve_update`, `py_reset`,
   `open_folder`, `pick_relink_target`.

The pattern is the plan's, applied inside an already-async body:
capture what the closure needs, `spawn_blocking`, `.await`, map the
join error. A command that awaits the async render gate keeps that
await outside the closure. The frontend does not change.

### Phase 6: progress and cancel on the long operations

The design, so the agent does not reinvent it:

- **One mechanism.** An event `heeler:progress` with `{op, id, done,
  total, message}` and a cancel registry keyed by `id` that the worker
  polls between units; one frontend progress row with a Cancel
  button, used by every operation below. Nothing operation-specific
  in the frontend beyond the words.
- **backup_catalog and move_catalog.** The copy is VACUUM INTO and
  stays so: it takes a consistent snapshot and defragments, which the
  SQLite backup API does not, so it is not switched for a counter.
  Progress is the partial file's size on disk, watched from the
  worker against the source's size; cancel is the connection's
  progress handler returning interrupt, after which the partial file
  is left where it is and named in the message, as the never-delete
  rule already requires. Move never runs `set_active_catalog` on a
  cancel.
- **import_catalog.** `import_from` takes a should-stop flag and a
  progress callback (rows examined, rows added); a cancel aborts the
  transaction, so nothing half-lands.
- **relink_folder.** Progress is files checked against matched;
  cancel between files is safe since the writes are per image.
- **clear_proxies, clear_smart_rasters.** Per-file progress over the
  walk; cancel between files is safe, the cache rebuilds; the keep
  list is computed before the first removal so a cancel never touches
  a live raster.
- **clear_thumbnails.** One statement: a spinner, no cancel.

Built 2026-09-20 (6e5d4d6d to 6b87abf1, one commit an operation) and
reviewed the same day. The review added: a restore refuses a leftover
.restoring file before anything moves and puts the previous catalog and
its journal back on any failure after the set-aside, not only a cancel
(a second restore after a canceled one used to strand the live catalog
under a date and let the next open build an empty one); the import's
stop flag also rides the connection's progress handler, so a cancel
lands inside the images insert instead of after it; reports go out at
most every 100 ms per operation (the sweeps report per file); and the
frontend raises a row only for an operation a launcher has running, so
a report that crosses the IPC after the command's answer cannot leave a
row with a live Cancel button behind. Left alone on purpose: the
panorama stitch and the export batch have progress channels that
predate this one.

## How to prove each conversion

A JavaScript mock alone is not sufficient and has already failed to catch this class once.
The 2026-09-12 work established the pattern to follow, and its tests are the template:

1. **A source-shape assertion** that the native command is dispatched and uses
   `spawn_blocking`. This is what catches a regression to a bare `fn`, because the behavior
   is identical on a fast local disk and only diverges on a slow volume.
2. **A frontend test that interacts with the UI while the command's promise is unresolved.**
   A deferred mock alone passes against the old synchronous code and proves nothing.
3. **A controlled slow probe** rather than a real external disk. The earlier work injected a
   delay and asserted the UI stayed live; manual external-volume timing tests exist but are
   ignored in normal suites and clearly named. Keep that split. Normal tests must not need an
   external volume or download a model.

### Worth adding: make the rule enforceable

`lib.rs` already has a test called `every_command_is_in_the_invoke_handler`, written after
the third time something was declared in one place and not registered in another. The same
technique applies here. Add a test that scans the source for `#[tauri::command]` followed by
a bare `fn` whose body matches the I/O patterns, and fails with an allowlist for the
deliberate exceptions (`set_maximize_button_rect`, the CPU helpers, the trivial getters).
That converts this document into something that cannot silently regrow, which is the actual
reason 67 of 69 are still here a week later.

## Traps

- Test modules in `lib.rs` must stay **last** in the file or the file safety guard goes blind.
- No `#[cfg(test)]` on a function outside the test modules, for the same reason: the
  source-scanning tests take the first one in the file as where the tests begin
  (2026-09-20: two test-only wrappers marked that way blinded both scanners).
- The test functions `every_command_is_in_the_invoke_handler` and
  `every_popout_window_has_capabilities` reference `#[tauri::command]` in source-scanning
  assertions and will be picked up by naive greps. They are not commands.
- Any new command added during this work must be registered in the invoke handler or the
  existing test fails, which is the intended behavior.
- Land on the runner's own exit code, not on a grep of its output.

## Re-running the audit

```python
# python3 - < this, from the repo root
import re, pathlib
SRC = pathlib.Path("apps/heeler-app/src-tauri/src")
PATS = {
 "cat":  re.compile(r"\bwith_catalog\b"),
 "sess": re.compile(r"\bwith_session\b"),
 "lock": re.compile(r"\.lock\(\)|Mutex|RwLock"),
 "fs":   re.compile(r"\bfs::|File::|read_to_string|read_dir|create_dir|remove_file"
                    r"|remove_dir|\bcopy\(|\brename\(|canonicalize|metadata\(|OpenOptions"),
 "proc": re.compile(r"Command::new|reqwest|ureq|TcpListener"),
}
tot = sync = risky = 0
for p in sorted(SRC.glob("*.rs")):
    lines = p.read_text(errors="ignore").splitlines()
    for i, l in enumerate(lines):
        if "#[tauri::command]" not in l:
            continue
        j = i + 1
        while j < len(lines) and not re.match(r"\s*(pub\s+)?(async\s+)?fn\s", lines[j]):
            j += 1
        if j >= len(lines):
            continue
        tot += 1
        if "async fn" in lines[j]:
            continue
        sync += 1
        depth, started, body = 0, False, []
        k = j
        while k < len(lines):
            body.append(lines[k])
            depth += lines[k].count("{") - lines[k].count("}")
            started = started or "{" in lines[k]
            if started and depth <= 0:
                break
            k += 1
        if any(pat.search("\n".join(body)) for pat in PATS.values()):
            risky += 1
            print(f"{p.name}:{j+1} {re.search(r'fn (\w+)', lines[j]).group(1)}")
print(f"\ntotal {tot}  sync {sync}  sync-with-io-or-lock {risky}")
```

Subtract the two test functions named under Traps from any count this produces.
