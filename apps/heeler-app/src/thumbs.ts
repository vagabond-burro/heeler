// Thumbnails on demand (2026-09-19: "Just load the UI, and let the
// fresh thumbnails regenerate realtime in the thumbnail strip of the
// currently selected folder"; "worry about the other 90 thumbnails
// later when the user browses back to the folder").
//
// A folder open used to queue a decode for every photograph in the
// folder, six at a time, in folder order, whether or not its cell was on
// screen. On a catalog whose stored thumbnails are gone (a restored
// backup leaves them out) that is hundreds of RAW decodes at boot, and
// every other command queues behind them: the twenty-five seconds the
// owner read as "reading the catalog". Now a cell asks for its own
// thumbnail when it scrolls into view and withdraws the ask when it
// scrolls out again before the decode started, so the work is the
// screen's worth and no more, spread over the browsing.

import { loadThumbnail } from "./bridge";
import { logDebug } from "./log";
import type { Command, ImageEntry } from "./state";

type D = (cmd: Command) => void;

/** Decodes in flight at once. Three: enough to fill a screen of cells in
 * a second or two from embedded previews, few enough that the runtime's
 * workers still answer everything else. */
const CONCURRENCY = 3;

/** The graph a photograph with no embedded preview renders its
 * thumbnail through (a merge), from the live state; the app
 * registers it at mount. Null when the photograph needs none. */
type GraphFor = (id: string, name?: string, source?: ImageEntry) => unknown;
let graphFor: GraphFor = () => null;

/** The app's state reader for thumbnail graphs. */
export function setThumbnailGraphs(fn: GraphFor): void {
  graphFor = fn;
}

/** The graph for one photograph's thumbnail, or undefined. */
export function thumbnailGraph(id: string, name?: string, source?: ImageEntry): unknown {
  return graphFor(id, name, source) ?? undefined;
}

let session = 0;
let dispatch: D | null = null;
let edge = 480;
/** Cells waiting, most recently asked LAST: the queue is read from the
 * front, so a batch of cells that came into view together loads in
 * their order on screen. */
const queue: string[] = [];
const inFlight = new Set<string>();
const answered = new Set<string>();
let running = 0;
let requested = 0;
let done = 0;

/** A new folder or catalog: whatever was queued for the old one is
 * dropped, and the cells of the new one ask as they appear. */
export function beginThumbSession(next: D, thumbnailEdge: number): void {
  session += 1;
  dispatch = next;
  edge = thumbnailEdge;
  queue.length = 0;
  inFlight.clear();
  answered.clear();
  requested = 0;
  done = 0;
  logDebug(() => `thumbnails: session ${session} begins, on demand at edge ${edge}`);
  progress();
}

function progress(): void {
  if (!dispatch) return;
  dispatch({
    type: "set_thumb_progress",
    progress: requested > done ? { done, total: requested } : null,
  });
}

/** A cell that is on screen without a picture asks for one. Asked twice
 * is asked once. */
export function wantThumb(id: string): void {
  if (!dispatch || answered.has(id) || inFlight.has(id) || queue.includes(id)) return;
  queue.push(id);
  pump();
}

/** A cell that scrolled away before its decode started withdraws the
 * ask; one already decoding finishes, since the result is stored in the
 * catalog and serves the next visit. */
export function unwantThumb(id: string): void {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
}

function pump(): void {
  while (running < CONCURRENCY && queue.length > 0) {
    const id = queue.shift()!;
    const token = session;
    const d = dispatch;
    if (!d) return;
    running += 1;
    inFlight.add(id);
    requested += 1;
    progress();
    void loadThumbnail(id, edge, thumbnailGraph(id))
      .catch(() => null)
      .then((src) => {
        running -= 1;
        if (token !== session) {
          // The slot is shared across sessions, but the marker belongs
          // to the current one. Wake its queue without touching its ids.
          pump();
          return;
        }
        inFlight.delete(id);
        answered.add(id);
        done += 1;
        if (src) d({ type: "set_thumb", id, src });
        progress();
        pump();
      });
  }
}

/** What the scheduler holds, for tests and the debug log. */
export function thumbQueueForTests(): { queued: string[]; inFlight: string[]; requested: number; done: number } {
  return { queued: [...queue], inFlight: [...inFlight], requested, done };
}

/** Test hook. */
export function resetThumbsForTests(): void {
  session += 1;
  dispatch = null;
  graphFor = () => null;
  queue.length = 0;
  inFlight.clear();
  answered.clear();
  running = 0;
  requested = 0;
  done = 0;
}
