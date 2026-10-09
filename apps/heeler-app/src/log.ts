// App log: ring buffer behind the Console window. Taps console.error/warn
// and global errors so messages like engine-preview failures are visible
// and copyable instead of vanishing into the webview devtools.

export interface LogEntry {
  time: string;
  level: "error" | "warn" | "info" | "debug";
  message: string;
}

// A few thousand, not 500: a DEBUG repro session blows through 500
// before the user finishes reproducing, and the whole point of the
// tier is that the copied log still holds the beginning of the story
// ("there are plenty of cases where 500 lines might not
// capture the real issue"). Strings at this scale are trivial
// memory.
const MAX_ENTRIES = 3000;

/** Tells subscribers on a microtask, coalesced. A log line can be born
 * INSIDE a React render (the reducer's debug spine runs there, and
 * React invokes reducers during render), and notifying synchronously
 * made the status bar's DEBUG-marker subscription set state while App
 * was still rendering. The owner's console: "Cannot update a
 * component (StatusBar) while rendering a different component (App)."
 * The entries array itself still updates synchronously; only the
 * wake-up waits for the stack to unwind.*/
let notifyQueued = false;
function scheduleNotify(): void {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    listeners.forEach((l) => l());
  });
}

/* ------------------------------------------------------------------ */
/* Verbosity. INFO always; DEBUG is a per-session opt-in that RESETS  */
/* on launch, on purpose: "Users leaving on DEBUG are bound to        */
/* experience slow downs if they forget to switch it back". The*/
/* level lives here in memory and is never persisted.                 */
/* ------------------------------------------------------------------ */

export type LogLevel = "info" | "debug";
let logLevel: LogLevel = "info";

export function getLogLevel(): LogLevel {
  return logLevel;
}

/** Sets the verbosity for THIS window, tells every other window over
 * the log channel, and tells the Rust side so its own debug seams
 * light up too. `fromChannel` applies a broadcast without re-sending
 * it (the same discipline ingestLog follows). */
export function setLogLevel(level: LogLevel, fromChannel = false): void {
  if (level === logLevel) return;
  logLevel = level;
  version += 1;
  scheduleNotify();
  if (!fromChannel) {
    broadcastLog?.({ level });
    if (typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined") {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("set_log_level", { debug: level === "debug" }).catch(() => {}),
      );
    }
  }
}

/** A debug line, dropped AT THE SOURCE when the level is INFO: no
 * string build (pass a closure on hot paths), no buffering, no
 * broadcast, no file write. Off means off. */
export function logDebug(message: string | (() => string)): void {
  if (logLevel !== "debug") return;
  logMsg("debug", typeof message === "function" ? message() : message);
}

/* ------------------------------------------------------------------ */
/* Path scrubbing, for the privacy of a pasted bug report. The home   */
/* directory renders as ~ everywhere (the username is the payload in  */
/* most paths, and a shortened RAW path is still findable); DEBUG      */
/* lines additionally shorten paths under an opened catalog root to   */
/* [catalog]/..., which also covers the Windows habit of working on   */
/* secondary drives where nothing is under home.                      */
/* ------------------------------------------------------------------ */

let homePrefix: string | null = null;
const catalogRoots: string[] = [];

export function setLogHome(home: string): void {
  homePrefix = home.replace(/[\/]+$/, "");
}

export function addLogCatalogRoot(root: string): void {
  const r = root.replace(/[\/]+$/, "");
  if (r && !catalogRoots.includes(r)) catalogRoots.push(r);
}

function scrubPaths(message: string, level: LogEntry["level"]): string {
  let out = message;
  if (level === "debug") {
    for (const root of catalogRoots) {
      while (out.includes(root)) out = out.replace(root, "[catalog]");
    }
  }
  if (homePrefix) {
    while (out.includes(homePrefix)) out = out.replace(homePrefix, "~");
  }
  return out;
}
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let version = 0;

export function logMsg(level: LogEntry["level"], message: string): void {
  // A debug line that arrives here with the level at INFO (a stray
  // caller, the Rust side racing a toggle) is dropped the same way
  // logDebug drops it.
  if (level === "debug" && logLevel !== "debug") return;
  message = scrubPaths(message, level);
  // Local wall-clock time: toISOString is UTC and read as a wrong clock.
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  ingestLog({ time, level, message });
  persistLine(`[${time}] ${level.toUpperCase()} ${message}`);
  // Every window keeps its own store; the channel keeps them agreeing,
  // so the popped-out console shows what the main window logged.
  broadcastLog?.({ entry: { time, level, message } });
}

/* ------------------------------------------------------------------ */
/* On-disk persistence. The ring buffer above dies with the session,  */
/* and the first move when something breaks is to restart the app,    */
/* which threw away exactly the evidence a debugging session needs    */
/* (which render call wedged, what the retries said). Every entry is  */
/* also appended to heeler-console.log in the app data dir.           */
/* ------------------------------------------------------------------ */

const pendingLines: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function persistLine(line: string): void {
  if (typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === "undefined")
    return;
  pendingLines.push(line);
  flushTimer ??= setTimeout(flushPersisted, 1000);
}

async function flushPersisted(): Promise<void> {
  flushTimer = undefined;
  if (!pendingLines.length) return;
  const lines = pendingLines.splice(0);
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("append_console_log", { lines });
  } catch {
    // The file is a debugging aid: a failed write is dropped, never
    // logged, or one bad write would fill the buffer with its own
    // complaints.
  }
}

/** Appends without re-broadcasting: the path entries arrive on FROM the
 * channel, and the path local ones share. */
function ingestLog(entry: LogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  version += 1;
  scheduleNotify();
}

interface LogSyncPayload {
  entry?: LogEntry;
  clear?: boolean;
  /** a window changed the verbosity; every window follows */
  level?: LogLevel;
  /** a fresh window asking for the story so far */
  hello?: boolean;
  /** the story so far, answered to a hello */
  replay?: LogEntry[];
}

let broadcastLog: ((payload: LogSyncPayload) => void) | null = null;

/** Wires this window's log store to the cross-window channel. Called
 * once at boot by every window role; the console pop-out depends on it.
 *
 * The hello/replay handshake exists because the live feed only carries
 * what happens AFTER a window is born: the console window opened onto
 * an empty buffer while the line that prompted opening it (Help >
 * About, say) sat in the main window's history. "it broke
 * Help > About (it doesn't show anything)." A new window says hello;
 * whoever has history answers with all of it; a window that already
 * has content ignores replays, which also breaks the ping-pong.*/
export function connectLogSync(
  send: (payload: LogSyncPayload) => void,
  subscribe: (fn: (payload: LogSyncPayload) => void) => void
): void {
  broadcastLog = send;
  subscribe((payload) => {
    if (payload?.hello) {
      if (entries.length) send({ replay: entries.slice() });
    } else if (payload?.replay) {
      if (!entries.length && payload.replay.length) {
        entries.push(...payload.replay);
        version += 1;
        scheduleNotify();
      }
    } else if (payload?.level) {
      setLogLevel(payload.level, true);
    } else if (payload?.clear) {
      entries.length = 0;
      version += 1;
      scheduleNotify();
    } else if (payload?.entry) {
      ingestLog(payload.entry);
    }
  });
  send({ hello: true });
}

/** Monotonic change counter: the store snapshot for useSyncExternalStore
 * (the entries array is mutated in place, so it can't be the snapshot). */
export function logVersion(): number {
  return version;
}

export function getEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries.length = 0;
  version += 1;
  scheduleNotify();
  broadcastLog?.({ clear: true });
}

export function subscribeLog(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function logAsText(): string {
  return entries.map((e) => `[${e.time}] ${e.level.toUpperCase()} ${e.message}`).join("\n");
}

let installed = false;

/** React's update-loop warning carries no component: it is raised while
 * passive effects flush, where React knows no current component, so the
 * log said only "Maximum update depth exceeded" (the owner's console,
 * 2026-09-30 12:31:47) and nothing could say which effect looped. The
 * warning is raised synchronously inside the setState or dispatch that
 * crossed the limit, so the JavaScript stack at that moment runs
 * through the effect that made it: its frames outside React and this
 * tap are appended, the effect's own file and line first. Any other
 * message comes back as it was.*/
export function withLoopStack(message: string, stack: string | undefined): string {
  if (!message.includes("Maximum update depth exceeded") || !stack) return message;
  const frames = stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") || /@/.test(l))
    .filter((l) => !/react-dom|react\.development|scheduler|chunk-|\/log\.ts|withLoopStack/.test(l))
    .slice(0, 6);
  return frames.length ? `${message} Raised from: ${frames.join(" < ")}` : message;
}

/** Wraps console.error/warn and global error events into the buffer. */
export function installConsoleTap(): void {
  if (installed) return;
  installed = true;
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      const message = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
      logMsg(level, withLoopStack(message, new Error().stack));
    };
  }
  window.addEventListener("error", (e) => logMsg("error", e.message));
  window.addEventListener("unhandledrejection", (e) =>
    logMsg("error", `Unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`)
  );
}
