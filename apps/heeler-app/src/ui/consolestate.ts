// The Console's state that lives outside any one window: the Python
// session's entries and their sync between the main window and the Console
// window, the echo of commands, the scratch tabs, and Python's highlighting
// words. No components live here, so console.tsx exports components alone
// and Vite can refresh it in place as it is edited instead of reloading the
// window.
import { getLogLevel, logMsg } from "../log";
import { flashStatus } from "./hints";
import { isMac, modLabel } from "../platform";
import { closeConsoleWindow, openConsoleWindow } from "../popout";

// ---------------------------------------------------------------------
// The Python session lives at module level, like the log: closing the
// panel or switching tabs must not amnesia the scrollback, because the
// interpreter underneath keeps its namespace either way.

export interface PyEntry {
  kind: "in" | "out" | "err" | "val" | "echo";
  text: string;
}

export const pyEntries: PyEntry[] = [];

export const pyListeners = new Set<() => void>();

export let pyVer = 0;

export let pyBusy = false;
/** Sets whether Python is running, from the panel (an import is read-only where it is imported). */
export function setPyBusy(v: boolean): void {
  pyBusy = v;
}

export function pyNotify(): void {
  pyVer += 1;
  pyListeners.forEach((l) => l());
}

export function pushPy(kind: PyEntry["kind"], text: string): void {
  if (!text) return;
  pyEntries.push({ kind, text });
  pyNotify();
  broadcastPy?.({ entry: { kind, text } });
}

export interface PySyncPayload {
  entry?: PyEntry;
  clear?: boolean;
  /** the echo toggle, kept agreeing across windows */
  echo?: boolean;
  /** the popped-out console announcing itself (true) or leaving (false) */
  window?: boolean;
}

export let broadcastPy: ((payload: PySyncPayload) => void) | null = null;

export let pySyncSubscribed = false;

// ---------------------------------------------------------------------
// Echo (see echo.ts for the translation): module state like the
// scrollback, because it describes the console, not any one mount.
//
// The gate the dispatch tap checks is echoEnabled && a console actually
// showing; when neither the panel nor the console window is up, the tap does
// not even translate. On a 3D package's version: "If you left echo on and
// closed the script edit it would still be verbose in the background and
// after awhile actually slow things down."

export let echoOn = false;

/** Whether the popped-out console window is alive, as announced over
 * the sync channel. The panel's own openness lives in app state. */
export let windowLive = false;

export function echoEnabled(): boolean {
  return echoOn;
}

export function consoleWindowLive(): boolean {
  return windowLive;
}

export const windowListeners = new Set<(open: boolean) => void>();

/** Hears every change of the console window's liveness: the main
 * window mirrors it into state, which is what lets the layout remember
 * the console the way it remembers the other pop-outs. */
export function onConsoleWindow(fn: (open: boolean) => void): () => void {
  windowListeners.add(fn);
  return () => {
    windowListeners.delete(fn);
  };
}

/** The console button and its hotkey: open the OS console window, or
 * close it when it is already up. The console is never an in-app
 * float. "It always needs to spawn as an OS window."*/
export async function toggleConsoleWindow(): Promise<void> {
  if (windowLive) {
    await closeConsoleWindow().catch(() => {});
    return;
  }
  try {
    await openConsoleWindow();
  } catch (err) {
    logMsg("error", `Console window failed to open: ${String(err)}`);
  }
}

export function setEcho(on: boolean): void {
  if (echoOn === on) return;
  echoOn = on;
  pushPy("echo", on
    ? "# echo on: your clicks, as runnable Python"
    : "# echo off");
  pyNotify();
  broadcastPy?.({ echo: on });
}

/** The dispatch tap's outlet: one translated line into the scrollback. */
export function pushEcho(line: string): void {
  pushPy("echo", line);
}

/** The windowed console calling home; also invoked from its
 * beforeunload so the main window stops translating the moment the
 * window goes away. */
export function announceConsoleWindow(open: boolean): void {
  windowLive = open;
  broadcastPy?.({ window: open });
  for (const fn of windowListeners) fn(open);
}

/** Wires this window's Python scrollback to the cross-window channel,
 * so the popped-out console and the in-app one show one session. The
 * interpreter itself already IS one (it lives in Rust); this keeps the
 * transcript agreeing with it. Subscribes once per window however many
 * times a mount asks. */
export function connectPySync(
  send: (payload: PySyncPayload) => void,
  subscribe: (fn: (payload: PySyncPayload) => void) => void
): void {
  broadcastPy = send;
  if (pySyncSubscribed) return;
  pySyncSubscribed = true;
  subscribe((payload) => {
    if (payload?.clear) {
      pyEntries.length = 0;
      pyNotify();
    } else if (payload?.entry) {
      pyEntries.push(payload.entry);
      pyNotify();
    } else if (typeof payload?.echo === "boolean") {
      // Assigned directly, not through setEcho: the sender already
      // pushed the announcement line and a re-broadcast would ping-pong.
      echoOn = payload.echo;
      pyNotify();
    } else if (typeof payload?.window === "boolean") {
      const was = windowLive;
      windowLive = payload.window;
      for (const fn of windowListeners) fn(windowLive);
      // The console going away with DEBUG still armed is exactly when
      // someone forgets it ("Should print a warning to the
      // status bar if they leave DEBUG on and close the console window").
      if (was && !payload.window && getLogLevel() === "debug") {
        flashStatus(
          "DEBUG logging is still on and can slow the app down. Reopen the Console to set it back to INFO, or relaunch (it resets itself).",
          8000,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------
// Scratchboard tabs, 3D-package style: several scripts open at
// once, each a tab over the one editor. The whole set persists to
// localStorage on every edit, so a crash or a close loses nothing.

export interface ScratchTab {
  name: string;
  text: string;
  /** Where this tab lives on disk; null for an unsaved scratch. */
  path: string | null;
  /** The text as of the last load or save; the dirty dot compares. */
  saved: string | null;
}

export const SCRATCH_KEY = "heeler.py.scratch";

export let tabs: ScratchTab[] = [{ name: "Scratch 1", text: "", path: null, saved: null }];

export let activeTab = 0;
/** Sets the scratch tab on show, from the panel (an import is read-only where it is imported). */
export function setActiveTab(v: number): void {
  activeTab = v;
}

export function restoreScratch(): void {
  try {
    const raw = localStorage.getItem(SCRATCH_KEY);
    if (!raw) return;
    const s = JSON.parse(raw) as { tabs?: unknown[]; active?: number };
    if (Array.isArray(s.tabs) && s.tabs.length) {
      tabs = s.tabs.map((t) => {
        const o = t as Partial<ScratchTab>;
        return {
          name: String(o.name ?? "Scratch"),
          text: String(o.text ?? ""),
          path: o.path == null ? null : String(o.path),
          saved: o.saved == null ? null : String(o.saved),
        };
      });
      activeTab = Math.min(Math.max(0, Number(s.active) || 0), tabs.length - 1);
    }
  } catch {
    // A broken blob must not brick the console; start fresh instead.
  }
}

/** Test hook: re-runs the crash-recovery load against localStorage. */
export const _restoreScratchForTests = restoreScratch;

// ---------------------------------------------------------------------
// Syntax coloring: a small tokenizer, not a grammar. Comments, strings,
// numbers, keywords and builtins cover what a console line looks like;
// anything it misses stays body-colored, which is the safe failure.

export const PY_KEYWORDS = new Set(
  ("False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try " +
    "while with yield").split(" ")
);

export const PY_BUILTINS = new Set(
  ("print len range repr str int float bool dict list set tuple open enumerate zip min max " +
    "sum abs round sorted reversed type isinstance getattr setattr hasattr dir help heeler h").split(" ")
);

export const PY_COLOR = {
  keyword: "#c792ea",
  builtin: "#82aaff",
  string: "#c3e88d",
  number: "#e0a247",
  comment: "#6b7076",
} as const;

export const PY_TOKEN =
  /(#[^\n]*)|("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g;

export function highlightPython(code: string): { text: string; color?: string }[] {
  const spans: { text: string; color?: string }[] = [];
  let last = 0;
  for (const m of code.matchAll(PY_TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) spans.push({ text: code.slice(last, at) });
    const [whole, comment, string, number, word] = m;
    if (comment) spans.push({ text: whole, color: PY_COLOR.comment });
    else if (string) spans.push({ text: whole, color: PY_COLOR.string });
    else if (number) spans.push({ text: whole, color: PY_COLOR.number });
    else if (word && PY_KEYWORDS.has(word)) spans.push({ text: whole, color: PY_COLOR.keyword });
    else if (word && PY_BUILTINS.has(word)) spans.push({ text: whole, color: PY_COLOR.builtin });
    else spans.push({ text: whole });
    last = at + whole.length;
  }
  if (last < code.length) spans.push({ text: code.slice(last) });
  return spans;
}

/** The scratchboard's run key by the platform's name: the Mac's
 * Command, CTRL elsewhere (docs review 2026-10-01: the Run button said
 * Ctrl+Enter on a Mac too). The editor's key handler takes Enter with
 * Command or Control, so the key named is the key bound. */
export function runKeyName(): string {
  return `${modLabel("ctrl")}${isMac() ? "" : "+"}Enter`;
}

/** Test hook: empties the module-level session store between tests. */
export function _resetPyConsoleForTests(): void {
  pyEntries.length = 0;
  pyBusy = false;
  pyVer = 0;
  echoOn = false;
  windowLive = false;
  tabs = [{ name: "Scratch 1", text: "", path: null, saved: null }];
  activeTab = 0;
  try {
    localStorage.removeItem(SCRATCH_KEY);
  } catch {
    // jsdom without storage: nothing to clear.
  }
}
