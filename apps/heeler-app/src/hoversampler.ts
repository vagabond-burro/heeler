/** The eyedropper hover sampler: what the hue curve's, Recolor's and the
 * Color Set's hover ghosts share. Each had its own copy of this flow,
 * four refs apiece, and the copies drifted: the at-rest fix (26.4.2)
 * was written three times, and two more defects lived in one copy or
 * all three (26.4.3). A site keeps its own read and what it paints; this
 * keeps the scheduling.
 *
 * One sample in flight at a time: while one is out, the newest position
 * waits and goes when it lands, so the engine is never handed a queue of
 * stale positions. At most one sample every WINDOW_MS: a move inside the
 * window only queues its position, and the window's timer takes it as
 * the window closes when no sample is out to take it on landing, so the
 * ghost lands where the cursor came to rest. One timer at a time. */

export type HoverPoint = [number, number];

/** A site's read of the position. `latest` says whether this is still
 * the newest sample, so an older answer is dropped rather than painted
 * over it. Null when there is nothing to read (no sample starts).
 * `landed` settles once the sample is answered and painted (its own
 * errors handled); `resume` says, when it has, whether the position
 * that waited for it may go. */
export type HoverRead = (at: HoverPoint, latest: () => boolean) => { landed: Promise<unknown>; resume: () => boolean } | null;

export const WINDOW_MS = 40;

export class HoverSampler {
  private busy = false;
  private next: HoverPoint | null = null;
  private stamp = 0;
  private seq = 0;
  private rest: ReturnType<typeof setTimeout> | null = null;

  /** `ready` says whether the window's timer may take the queued position
   * (the site still armed, no drag of its own under way). */
  constructor(private ready: () => boolean) {}

  /** A hover move to `at`, read by `read` if it goes now or as the
   * window closes. */
  move(at: HoverPoint, read: HoverRead) {
    if (this.busy) {
      this.next = at;
      return;
    }
    const now = performance.now();
    if (now - this.stamp < WINDOW_MS) {
      this.next = at;
      this.atRest(WINDOW_MS - (now - this.stamp), read);
      return;
    }
    this.stamp = now;
    // Anything queued is older than this move (a window's timer that
    // ran late); it must not be sampled after it.
    this.next = null;
    this.start(at, read);
  }

  /** Forget the queued position: the cursor left the picture or pressed. */
  drop() {
    this.next = null;
  }

  /** The component is going: stop the window's timer. */
  dispose() {
    if (this.rest !== null) clearTimeout(this.rest);
  }

  private start(at: HoverPoint, read: HoverRead) {
    const seq = ++this.seq;
    const sample = read(at, () => seq === this.seq);
    if (!sample) return;
    this.busy = true;
    void sample.landed.finally(() => {
      this.busy = false;
      const next = this.next;
      this.next = null;
      if (next && sample.resume()) this.start(next, read);
    });
  }

  private atRest(wait: number, read: HoverRead) {
    if (this.rest !== null) return;
    this.rest = setTimeout(() => {
      this.rest = null;
      const next = this.next;
      if (!next || this.busy || !this.ready()) return;
      this.next = null;
      this.stamp = performance.now();
      this.start(next, read);
    }, Math.max(0, wait));
  }
}
