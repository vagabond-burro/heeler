// Formatting and state effects for an image's stack job.
import type { StackMerge } from "./state";
import { STACK_KINDS, STACK_SET_ASIDE, type StackProgress } from "./bridge";

const MODE_NAMES = Object.fromEntries(STACK_KINDS.map(k => [k.mode, k.progressLabel]));

const count = (n: number) => n.toLocaleString("en-US");

/** "about 25 s left", "about 3 min left". */
export function timeLeft(seconds: number): string {
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

/** The useful half: what the merge is, and where it has got. */
export function mergeLines(m: StackMerge): { title: string; detail: string; fraction: number } {
  const mode = MODE_NAMES[m.mode] ?? m.mode;
  const title = `Merging ${count(m.frames)} frames · ${mode}${m.full ? " · full resolution" : ""}`;
  const fraction = m.total > 0 ? Math.min(1, m.done / m.total) : 0;
  const parts: string[] = [];
  if (m.done === 0) {
    parts.push("Reading the first frame");
  } else {
    if (m.passes > 1) parts.push(`Pass ${m.pass + 1} of ${m.passes}`);
    const frame = m.done - m.pass * m.frames;
    parts.push(`${m.passes > 1 ? "frame" : "Frame"} ${count(Math.min(frame, m.frames))} of ${count(m.frames)}`);
    const seconds = m.elapsedMs / 1000;
    if (seconds >= 1.5) {
      const rate = m.done / seconds;
      parts.push(`${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} frames a second`);
      if (m.done < m.total) parts.push(timeLeft((m.total - m.done) / rate));
    }
  }
  // Left out, not unreadable: a frame of another size or one that
  // would not align is left out too, and reads perfectly well.
  if (m.missing > 0) parts.push(`${count(m.missing)} left out`);
  return { title, detail: parts.join(" · "), fraction };
}

/** What one progress event means for the app: the overlay's new state,
 * whether to render again (the merge landed in the proxy cache, and the
 * viewer's own request has usually given up waiting by now), and a
 * failure worth telling the user about. A merge the backend set aside
 * on purpose (the viewer moved on, the frames changed) is not one. */
export function stackEventEffects(p: StackProgress): {
  progress: StackMerge | null;
  rerender: boolean;
  failure: string | null;
} {
  if (p.finished) {
    const failed = p.error !== null && !(p.set_aside ?? p.error.startsWith(STACK_SET_ASIDE));
    return { progress: null, rerender: p.error === null, failure: failed ? p.error : null };
  }
  return {
    progress: {
      ...(p.job_id ? { jobId: p.job_id } : {}),
      image: p.image_id,
      done: p.done,
      total: p.total,
      pass: p.pass,
      passes: p.passes,
      frames: p.frames,
      missing: p.missing,
      mode: p.mode,
      full: p.full,
      elapsedMs: p.elapsed_ms,
    },
    rerender: false,
    failure: null,
  };
}

