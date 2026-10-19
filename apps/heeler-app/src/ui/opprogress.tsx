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
import { StackMergeProgress } from "./stackmerge";
import { useStageCenter } from "./stackmergeparts";
import { BAKE_DIALOG_DELAY_MS, canceled, current, firstHeard, heard, listeners, notes, started, titles } from "./opprogressparts";

// The operations shown as a modal dialog instead of a row (2026-09-30:
// "Bake Warp was really slow. I think a dialog should pop up with a
// progress bar if this is a slow process otherwise the user will think
// something is wrong."): a bake reads the picture the user is working
// on, so nothing else should be done to it while it runs.
const MODAL_OPS = new Set(["bake", "export"]);

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

/** The Cancel button of a row or the dialog: the worker's cancel, and
 * the launcher's own note that the user asked, so a result that lands in
 * the same moment is not applied either. */
function cancelRow(p: OpProgress): void {
  canceled.add(p.op);
  void cancelOperation(p.id);
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
  const since = p ? firstHeard.get(p.op) ?? started.get(p.op) : undefined;
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
