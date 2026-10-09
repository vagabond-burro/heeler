// The one progress row every long operation uses (Phase 6 of the
// main-thread stalls plan): a store fed by the heeler:progress event,
// one row per running operation with its message, a bar when the
// operation knows its total, and a Cancel button that sends the id
// back to the worker's cancel registry. Nothing here knows what any
// operation IS; the words arrive in the message.
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./dialogfocus";
import { cancelOperation, onOpProgress, type OpProgress } from "../bridge";
import type { StackMerge } from "../state";
import { StackMergeProgress, useStageCenter } from "./stackmerge";

let current: OpProgress[] = [];
const listeners = new Set<() => void>();
// The operations a launcher on this side has running. The event and
// the command's answer travel different roads through the IPC, so a
// report can land after the promise settled; a row for an operation
// nobody here is waiting on would sit with its Cancel button until the
// next run of the same operation settled, and is dropped instead.
const open = new Set<string>();

// The operations shown as a modal dialog instead of a row (2026-09-30:
// "Bake Warp was really slow. I think a dialog should pop up with a
// progress bar if this is a slow process otherwise the user will think
// something is wrong."): a bake reads the picture the user is working
// on, so nothing else should be done to it while it runs.
const MODAL_OPS = new Set(["bake"]);
// When each open operation began and what its dialog says it is doing,
// and the operations whose Cancel has been pressed this run.
const started = new Map<string, number>();
const titles = new Map<string, string>();
// A second line the dialog shows under its title (a bake's word on what
// the picture costs each recovery bundle, bakedbackups.ts).
const notes = new Map<string, string>();
const canceled = new Set<string>();

function heard(p: OpProgress) {
  if (!open.has(p.op)) return;
  current = current.some((r) => r.id === p.id)
    ? current.map((r) => (r.id === p.id ? p : r))
    : [...current, p];
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  // The event subscription rides the mount: keyed by id, a duplicate
  // feed would write the same row, so a remount simply re-subscribes.
  const un = onOpProgress(heard);
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    un();
  };
}

function snapshot(): OpProgress[] {
  return current;
}

/** A launcher says its operation is running: its reports may raise a
 * row from here until clearOp. */
export function beginOp(op: string, title?: string, note?: string): void {
  open.add(op);
  started.set(op, Date.now());
  canceled.delete(op);
  if (title) titles.set(op, title);
  if (note) notes.set(op, note);
  else notes.delete(op);
}

/** The Cancel button of a row or the dialog: the worker's cancel, and
 * the launcher's own note that the user asked, so a result that lands in
 * the same moment is not applied either. */
function cancelRow(p: OpProgress): void {
  canceled.add(p.op);
  void cancelOperation(p.id);
}

/** A launcher drops its operation's rows when its promise settles,
 * either way; the row's job is the wait, not the result. Reports that
 * arrive after this are ignored. */
export function clearOp(op: string): void {
  open.delete(op);
  started.delete(op);
  titles.delete(op);
  notes.delete(op);
  if (!current.some((r) => r.op === op)) return;
  current = current.filter((r) => r.op !== op);
  listeners.forEach((fn) => fn());
}

/** Runs one long operation under its progress row: the row can appear
 * once the job starts and goes when the promise settles, either way. */
export async function watchOp<T>(op: string, job: () => Promise<T>): Promise<T> {
  beginOp(op);
  try {
    return await job();
  } finally {
    clearOp(op);
  }
}

/** The bakes' op and the desktop's answer to a canceled one (lib.rs
 * BAKE_OP, BAKE_CANCELED). */
export const BAKE_OP = "bake";
export const BAKE_CANCELED = "Bake canceled";

/** How long a bake runs before its dialog shows: a bake that lands
 * sooner flashes nothing. */
export const BAKE_DIALOG_DELAY_MS = 500;

/** A bake under the progress dialog (Bake Warp, New Layer via Copy):
 * `title` is the dialog's plain line of what it is doing. Resolves to
 * the job's answer, or null when the user canceled it, whatever the job
 * answered (the desktop's "Bake canceled", or a result that landed as
 * Cancel was pressed, which is then not applied). */
export async function watchBake<T>(title: string, job: () => Promise<T>, note?: string): Promise<T | null> {
  beginOp(BAKE_OP, title, note);
  try {
    const out = await job();
    return canceled.has(BAKE_OP) ? null : out;
  } catch (e) {
    if (canceled.has(BAKE_OP) || String(e).includes(BAKE_CANCELED)) return null;
    throw e;
  } finally {
    clearOp(BAKE_OP);
  }
}

/** Test reset: every row gone and no operation open. */
export function clearAllOps(): void {
  current = [];
  open.clear();
  started.clear();
  titles.clear();
  notes.clear();
  canceled.clear();
  listeners.forEach((fn) => fn());
}

export function OpProgressOverlay() {
  const rows = useSyncExternalStore(subscribe, snapshot).filter((p) => !MODAL_OPS.has(p.op));
  if (rows.length === 0) return null;
  return (
    <div
      data-testid="op-progress"
      style={{
        position: "fixed",
        bottom: 46,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 400,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {rows.map((p) => (
        <div
          key={p.id}
          data-testid={`op-progress-${p.id}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "6px 12px",
            fontSize: 11,
            color: "var(--text-body)",
            background: "var(--bg-panel)",
            border: "1px solid #3a3735",
          }}
        >
          <span>{p.message}</span>
          {p.total > 0 && (
            <div style={{ width: 110, height: 3, background: "var(--slider-track)", borderRadius: 2, overflow: "hidden" }}>
              <div
                data-testid={`op-bar-${p.id}`}
                style={{
                  width: `${Math.min(100, Math.round((p.done / p.total) * 100))}%`,
                  height: "100%",
                  background: "var(--accent)",
                }}
              />
            </div>
          )}
          <button
            className="chip"
            data-testid={`op-cancel-${p.id}`}
            style={{ fontSize: 11, padding: "1px 8px" }}
            onClick={() => cancelRow(p)}
          >
            CANCEL
          </button>
        </div>
      ))}
    </div>
  );
}

/** A bake's progress as a modal dialog: its plain line of what it is
 * doing, a bar, the stage the desktop reports and Cancel. Shown once
 * the bake has run BAKE_DIALOG_DELAY_MS, so a quick one flashes
 * nothing; while it shows, the scrim takes every click, the picture
 * under it being the one the bake reads. Portaled to the body: inside a
 * .ui-zoom panel a dialog renders at the zoom squared.
 *
 * `merge` is the stack merge the bake is waiting on, when the photograph
 * being baked is a stack not yet merged at full size: the dialog shows
 * the merge's own card (frames, time left, Cancel merge) at once, and
 * the bake's bar after it (2026-10-08: the merge's card showed
 * behind the Bake dialog; "close the backing dialog, show the stacking
 * dialog, then show a baking progress dialog"). */
export function BakeProgressDialog({ merge = null }: { merge?: StackMerge | null } = {}) {
  const rows = useSyncExternalStore(subscribe, snapshot).filter((p) => MODAL_OPS.has(p.op));
  const p = rows[rows.length - 1];
  const since = p ? started.get(p.op) : undefined;
  const [, wake] = useState(0);
  const wait = since === undefined ? 0 : since + BAKE_DIALOG_DELAY_MS - Date.now();
  const waiting = wait > 0;
  useEffect(() => {
    if (!waiting || since === undefined) return;
    const t = window.setTimeout(() => wake((n) => n + 1), Math.max(0, since + BAKE_DIALOG_DELAY_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [waiting, since]);
  const merging = !!p && !!merge;
  const visible = merging || (!!p && since !== undefined && !waiting);
  const focus = useDialogFocus(visible);
  const center = useStageCenter(merging);
  if (!visible) return null;
  if (merging) {
    const card = (
      <div className="modal-scrim" data-testid="bake-merge-scrim" style={{ zIndex: 450 }} onMouseDown={(e) => e.stopPropagation()}>
        <div ref={focus} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Merging the stack to bake it" data-testid="bake-merge" onKeyDown={(e) => {
          e.stopPropagation();
          // Escape ends both: the merge (its own job) and the bake
          // waiting on it.
          if (e.key === "Escape") {
            e.preventDefault();
            if (merge!.jobId) void cancelOperation(merge!.jobId);
            cancelRow(p!);
          }
        }}>
          <StackMergeProgress merge={merge!} style={center ? { left: center.left, top: center.top } : undefined} />
        </div>
      </div>
    );
    return typeof document !== "undefined" && document.body ? createPortal(card, document.body) : card;
  }
  const title = titles.get(p.op) ?? "Working at full size";
  const note = notes.get(p.op);
  const share = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
  const dialog = (
    <div className="modal-scrim" data-testid="bake-scrim" style={{ zIndex: 450 }} onMouseDown={(e) => e.stopPropagation()}>
      <div ref={focus} tabIndex={-1} onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); cancelRow(p); }
      }} role="dialog" aria-modal="true" aria-label={title} className="modal" data-testid="bake-dialog" style={{ width: 360, display: "flex", flexDirection: "column", gap: 10 }}>
        <div data-testid="bake-dialog-title" style={{ fontSize: 13, color: "var(--text-body)" }}>
          {title}
        </div>
        {note && (
          <div data-testid="bake-dialog-note" style={{ fontSize: 12, color: "var(--text-faint)", lineHeight: 1.4 }}>
            {note}
          </div>
        )}
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} style={{ height: 4, background: "var(--slider-track)", borderRadius: 2, overflow: "hidden" }}>
          <div data-testid="bake-dialog-bar" style={{ width: `${share}%`, height: "100%", background: "var(--accent)", transition: "width 120ms linear" }} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span data-testid="bake-dialog-stage" style={{ flex: 1, fontSize: 12, color: "var(--text-faint)" }}>
            {p.message}
          </span>
          <button className="chip" data-testid="bake-dialog-cancel" style={{ fontSize: 11, padding: "2px 10px" }} onClick={() => cancelRow(p)}>
            CANCEL
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}
