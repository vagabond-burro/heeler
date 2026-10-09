// The preview pump's retry policy, in its own module rather than next
// to the pump: app.tsx exports the App component, and a module that
// mixes component and non-component exports defeats Vite's fast
// refresh: every edit then costs a full reload instead of a hot swap.

/** How many times a failed preview render is re-asked before the pump
 * gives up and waits for the next edit (or the next window-focus nudge).
 * Each attempt can itself wait out RENDER_TIMEOUT_MS when the engine is
 * wedged rather than merely erroring, so the backoff stays short; the
 * timeout is the slow part. */
export const PREVIEW_RETRY_ATTEMPTS = 5;

/** Backoff between preview retries: 1s, 2s, 4s, 8s, 16s. */
export function previewRetryDelay(attempt: number): number {
  return 1000 * 2 ** Math.max(0, attempt - 1);
}

/** True for the one failure that retrying cannot mend.
 *
 * Matched on the message because that is what crosses the bridge: the
 * backend hands back a string, and the two shapes here are the
 * decoder's raw io error and the friendlier check that beats it to the
 * punch when the session knows the path already.
 */
export function isMissingSource(error: string): boolean {
  const e = error.toLowerCase();
  return (
    e.includes("no such file or directory") ||
    e.includes("os error 2") ||
    e.includes("is missing or moved")
  );
}

/** The file a decode error was about, when it names one.
 *
 * The owner, reading "io error: No such file or directory (os error
 * 2)": "What file? I don't know where to look to even understand how to
 * fix this. It should show me the expected file path." heeler-io now
 * appends `: <path>` to every failure it raises about a file
 * (IoError::At), deliberately last, so this can lift it back out and
 * the message can say where to look.
 *
 * The separator is the LAST ": " rather than the first: the reason in
 * front of it carries colons of its own ("io error: ..."), while a
 * Windows drive letter has no space after its colon. A tail with no
 * separator in it is not a path, which is what keeps an ordinary
 * engine error from being read as one.
 */
export function missingSourcePath(error: string): string | null {
  const at = error.lastIndexOf(": ");
  if (at < 0) return null;
  const tail = error.slice(at + 2).trim();
  return tail.length > 0 && /[\\/]/.test(tail) ? tail : null;
}
