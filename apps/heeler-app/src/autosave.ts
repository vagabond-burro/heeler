import { nextSaveRevision } from "./saverevision";

type Write = { revision: number; run: (revision: number) => Promise<void> };
/** Rounds a flush will wait for writes armed during the flush before it
 * gives up. Each round is a whole write; an editing session never
 * arms this many in the time a close takes. */
export const FLUSH_ROUNDS = 100;
export const KEEP_ARRIVING = "Edits keep arriving faster than they can be saved. Wait for the status bar to go quiet, then try again.";
type Work = { pending?: Write; running?: Promise<void>; failed?: Write; error?: string; timer?: ReturnType<typeof setTimeout>; ready: boolean; saved?: number };

/** Per-photograph queues retain failed payloads and serialize writes. A new
 * take/edit replaces the retry payload, never the other way around. */
export class SaveQueue {
  private work = new Map<string, Work>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  errors(): string[] { return [...this.work].flatMap(([id, work]) => work.error ? [`${id}: ${work.error}`] : []); }
  pendingImage(): string | null { return this.work.keys().next().value ?? null; }
  acknowledge(image: string, revision: number): void {
    const work = this.work.get(image);
    if (!work) return;
    work.saved = Math.max(work.saved ?? 0, revision);
    if (work.failed && work.failed.revision <= revision) { work.failed = undefined; work.error = undefined; }
    if (work.pending && work.pending.revision <= revision) { work.pending = undefined; if (work.timer) clearTimeout(work.timer); }
    if (!work.running && !work.pending && !work.failed) this.work.delete(image);
    this.changed();
  }
  arm(image: string, delay: number, run: Write["run"]): void {
    const work = this.work.get(image) ?? { ready: false };
    if (work.timer) clearTimeout(work.timer);
    work.pending = { revision: nextSaveRevision(image), run };
    work.failed = undefined; work.error = undefined; work.ready = false;
    work.timer = setTimeout(() => { work.ready = true; this.start(image, work); }, delay);
    this.work.set(image, work); this.changed();
  }
  private start(image: string, work: Work): void {
    if (work.running || !work.pending || !work.ready) return;
    if (work.timer) clearTimeout(work.timer);
    const write = work.pending; work.pending = undefined;
    work.running = Promise.resolve().then(() => write.run(write.revision)).then(() => {
      work.error = undefined;
    }, (error) => {
      if (!work.pending && write.revision > (work.saved ?? 0)) { work.failed = write; work.error = String(error); }
    }).then(() => {
      work.running = undefined;
      if (!work.pending && !work.failed) this.work.delete(image);
      else this.start(image, work);
      this.changed();
    });
  }
  cancelPending(image: string): void {
    const work = this.work.get(image);
    if (!work) return;
    if (work.timer) clearTimeout(work.timer);
    work.pending = undefined;
    if (!work.running && !work.failed) this.work.delete(image);
  }
  async flush(): Promise<boolean> {
    const hadWork = this.work.size > 0;
    // Retry failures only once per flush. New revisions arriving while flush
    // waits are included before it may authorize closing the window.
    for (const work of this.work.values()) {
      if (!work.pending && work.failed) { work.pending = work.failed; work.failed = undefined; }
    }
    // Bounded: a write that arms another write of its own would otherwise
    // hold the close forever. Past the cap the edits stay queued, the
    // window stays open, and the error says why, naming the writes that
    // failed beside the storm rather than swallowing them.
    for (let round = 0; ; round++) {
      for (const [image, work] of this.work) {
        work.ready = true; this.start(image, work);
      }
      const running = [...this.work.values()].flatMap(w => w.running ? [w.running] : []);
      if (!running.length) break;
      if (round >= FLUSH_ROUNDS) {
        const errors = this.errors();
        throw new Error(errors.length ? `${KEEP_ARRIVING} Edits are still unsaved. ${errors.join("; ")}` : KEEP_ARRIVING);
      }
      await Promise.all(running);
    }
    const errors = this.errors();
    if (errors.length) throw new Error(`Edits are still unsaved. ${errors.join("; ")}`);
    return hadWork;
  }
}
export const autosaves = new SaveQueue();
export const armAutosave = (image: string, delay: number, run: Write["run"]): void => autosaves.arm(image, delay, run);
export const flushAutosave = (): Promise<boolean> => autosaves.flush();
export const pendingAutosaveImage = (): string | null => autosaves.pendingImage();

/** Every close is prevented while flushing, including a repeated close request. */
export function saveBeforeClose(flush: () => Promise<unknown>, destroy: () => Promise<unknown>, report: (error: string) => void) {
  let closing = false;
  return async (event: { preventDefault(): void }) => {
    event.preventDefault();
    if (closing) return;
    closing = true;
    try { await flush(); await destroy(); }
    catch (error) { report(String(error)); }
    finally { closing = false; }
  };
}
