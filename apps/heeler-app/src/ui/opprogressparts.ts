// opprogress.tsx's values and helpers that are not components, kept apart so
// opprogress.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { type OpProgress } from "../bridge";

export let current: OpProgress[] = [];

export const listeners = new Set<() => void>();

// The operations a launcher on this side has running. The event and
// the command's answer travel different roads through the IPC, so a
// report can land after the promise settled; a row for an operation
// nobody here is waiting on would sit with its Cancel button until the
// next run of the same operation settled, and is dropped instead.
export const open = new Set<string>();

// When each open operation began and what its dialog says it is doing,
// and the operations whose Cancel has been pressed this run.
export const started = new Map<string, number>();

export const titles = new Map<string, string>();

// A second line the dialog shows under its title (a bake's word on what
// the picture costs each recovery bundle, bakedbackups.ts).
export const notes = new Map<string, string>();

export const canceled = new Set<string>();

// When each open operation's first report arrived. A dialog's delay
// counts from here: an export's first report comes once its save dialog
// has closed, and the time spent there is not the export's.
export const firstHeard = new Map<string, number>();

/** A launcher says its operation is running: its reports may raise a
 * row from here until clearOp. */
export function beginOp(op: string, title?: string, note?: string): void {
  open.add(op);
  started.set(op, Date.now());
  firstHeard.delete(op);
  canceled.delete(op);
  if (title) titles.set(op, title);
  if (note) notes.set(op, note);
  else notes.delete(op);
}

/** A launcher drops its operation's rows when its promise settles,
 * either way; the row's job is the wait, not the result. Reports that
 * arrive after this are ignored. */
export function clearOp(op: string): void {
  open.delete(op);
  started.delete(op);
  firstHeard.delete(op);
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

/** The exports' op and the desktop's answer to a canceled one (lib.rs
 * EXPORT_OP, EXPORT_CANCELED). */
export const EXPORT_OP = "export";

export const EXPORT_CANCELED = "Export canceled";

/** What an open operation's dialog says it is doing, changed while it
 * runs (a batch names the photograph it has reached). */
export function retitleOp(op: string, title: string): void {
  if (!open.has(op)) return;
  titles.set(op, title);
  listeners.forEach((fn) => fn());
}

/** Whether the user pressed Cancel on this operation's dialog this run. */
export function opCanceled(op: string): boolean {
  return canceled.has(op);
}

/** An export, or a batch of them, under the progress dialog (2026-10-17:
 * "a progress dialog for exports (whether batch or quick export) similar
 * to the stacking dialog would help"): `title` is the dialog's line.
 * Resolves to the job's answer, or null when the desktop honored Cancel. */
export async function watchExport<T>(title: string, job: () => Promise<T>): Promise<T | null> {
  beginOp(EXPORT_OP, title);
  try {
    const out = await job();
    // A successful answer means the files were already published.
    return out;
  } catch (e) {
    if (canceled.has(EXPORT_OP) || String(e).includes(EXPORT_CANCELED)) return null;
    throw e;
  } finally {
    clearOp(EXPORT_OP);
  }
}

/** Test reset: every row gone and no operation open. */
export function clearAllOps(): void {
  current = [];
  open.clear();
  firstHeard.clear();
  started.clear();
  titles.clear();
  notes.clear();
  canceled.clear();
  listeners.forEach((fn) => fn());
}

/** A progress report heard from the desktop: the row for an operation
 * being watched, added or brought up to date. */
export function heard(p: OpProgress) {
  if (!open.has(p.op)) return;
  if (!firstHeard.has(p.op)) firstHeard.set(p.op, Date.now());
  current = current.some((r) => r.id === p.id)
    ? current.map((r) => (r.id === p.id ? p : r))
    : [...current, p];
  listeners.forEach((fn) => fn());
}
