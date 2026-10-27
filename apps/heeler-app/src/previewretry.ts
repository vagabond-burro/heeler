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

/** The issue that tracks Nikon's High Efficiency RAW, backlogged until a
 * later date (2026-10-26). */
export const HIGH_EFFICIENCY_NEF_ISSUE = "https://github.com/vagabond-burro/heeler/issues/76";

/** True for a photograph the develop turns away for what the file is: a
 * RAW format or variant not read yet, a damaged file, a main image only
 * its thumbnail stands for, a develop that reads as noise. Retrying
 * cannot mend these any more than a missing file, and the generic
 * "hiccup" walk hid the reason in the log for half a minute. */
export function isUndevelopable(error: string): boolean {
  return /cannot be developed|thumbnail could be read|read as noise rather than a photograph/.test(error);
}

/** What the app says about an undevelopable photograph: its file name
 * and the decoder's reason, and for a High Efficiency NEF what to do
 * instead (2026-10-26: "list options (like convert to DNG) for users",
 * "link to the issue from the error"). `status` is for the status line,
 * one line that ends in an ellipsis when it runs out of room, so it
 * leads with the options; `log` is the whole of it, the issue's address
 * included, for the console. */
export function undevelopableMessage(error: string): { status: string; log: string } {
  const path = missingSourcePath(error);
  const name = path?.split(/[\\/]/).pop();
  const reason = (path ? error.slice(0, error.lastIndexOf(": ")) : error).replace(/^.*?unsupported: /, "");
  const who = name ?? "This photograph";
  if (/Nikon High Efficiency NEF/.test(error)) {
    const status = `${who}: Nikon's High Efficiency RAW is not supported yet. Record Lossless compressed RAW, or convert the file to DNG and open that. See Help > User Documentation > Library.`;
    return { status, log: `${status} Progress: ${HIGH_EFFICIENCY_NEF_ISSUE}${path ? ` (${path})` : ""}` };
  }
  return { status: `${who}: ${reason}`, log: `${who}: ${reason}${path ? ` (${path})` : ""}` };
}
