// Popping the node graph into its own window.
//
// The graph window is a thin client, not a second copy of the app. The
// main window stays the single owner of the reducer: the graph window
// renders a snapshot it is sent, and every command it raises is
// forwarded to the main window to be reduced there. Two reducers running
// the same commands would drift the moment one missed a message.
//
// Transport is Tauri events in the app and BroadcastChannel in a plain
// browser, so the feature is exercisable in dev without packaging.

import { onTauriEvent } from "./taurievents";
import type { Command, State } from "./state";
import { isTauri } from "./bridge";
import { logDebug, logMsg } from "./log";
import { flashStatus } from "./ui/hints";

/** Keep the docked controls available if a window cannot be created.
 * A late rejection from an obsolete request must not undo a newer choice. */
export function followPopout(out: boolean, name: string, open: () => Promise<void>, close: () => Promise<void>, onOpenFailure: () => void): () => void {
  let current = true;
  void (out ? open() : close()).catch(error => {
    if (!current) return;
    const message = `${name} window could not ${out ? "open" : "close"}: ${String(error)}`;
    logMsg("error", message);
    flashStatus(message, 8000);
    if (out) onOpenFailure();
  });
  return () => { current = false; };
}



/** The adjustment tools that pop into windows of their own, Color Bend
 * style. "make the following adjustment tools able to pop
 * out to larger floating windows... actually render new controls that
 * scale." One table, so the labels, titles and window sizes stay in one
 * place.*/
export const TOOL_WINDOWS = {
  wheels: { title: "Heeler Color Wheels", width: 900, height: 460 },
  curves: { title: "Heeler Curves", width: 760, height: 560 },
  toneeq: { title: "Heeler Relight", width: 860, height: 540 },
  recolor: { title: "Heeler Recolor", width: 880, height: 600 },
  colorconsole: { title: "Heeler Color Tune", width: 920, height: 520 },
} as const;

export type ToolWindowKind = keyof typeof TOOL_WINDOWS;

/** Every window identity: the fixed set plus whatever TOOL_WINDOWS
 * declares, so a new tool window can never be forgotten here. */
export type WindowRole = "main" | "graph" | "spectrum" | "takes" | "bend" | "console" | ToolWindowKind;

/** Commands the graph window raises, on their way to the main window. */
export const CMD_CHANNEL = "heeler:cmd";
/** State the main window pushes out to the graph window. */
export const STATE_CHANNEL = "heeler:graph-state";

/** A pop-out asking for a snapshot, the moment it can listen for one.
 *
 * "There's some lag when popping out the color blend. It says
 * 'waiting on main window' and takes a couple seconds to load the wheel."
 *
 * That wait was structural, not slow code. A new window is pushed a
 * snapshot when the state next CHANGES, and the change that opened it has
 * already been and gone by the time the webview has booted and subscribed
 * to anything. So it sat waiting for whatever happened to be edited next.
 * The graph window papered over it by dispatching a no-op command on
 * mount to force a change; asking outright is the honest version of that,
 * and it works for a window that has no command to spare. */
export const STATE_REQUEST = "heeler:state-request";
/** A key the popped-out graph window resolved to a command, by id, for
 * the main window to run against the state it owns. Before this the
 * pop-out had no key handling at all: Cmd+D, Delete, D and the rest
 * worked only in the docked graph, since a window's keys never reach
 * another window's listener. */
export const GRAPH_KEY_CHANNEL = "heeler:graph-key";
/** The graph window telling the main window it is going away. */
export const DOCK_CHANNEL = "heeler:dock";

export interface Transport {
  send(channel: string, payload: unknown): void;
  /** Returns an unsubscribe function. */
  subscribe(channel: string, fn: (payload: any) => void): () => void;
}

export function windowRole(
  search = typeof location === "undefined" ? "" : location.search,
): WindowRole {
  // Every pop-out role, not just the graph. This only knew about "graph",
  // so ?view=spectrum loaded a second copy of the whole app instead of
  // the spectrum window. Inside Tauri the window label decides and the
  // bug was invisible; in a browser it made the feature untestable,
  // which is the one job the query string has.
  const view = new URLSearchParams(search).get("view");
  if (view === "graph" || view === "spectrum" || view === "takes" || view === "bend" || view === "console") {
    return view;
  }
  // Tool windows come from the registry, never a hand list.
  if (view !== null && view in TOOL_WINDOWS) return view as WindowRole;
  return "main";
}

/** The label Tauri gives the popped-out graph window. Must match
 * GRAPH_WINDOW in the Rust side. */
export const GRAPH_LABEL = "graph";
export const SPECTRUM_LABEL = "spectrum";
/** The Takes review window: notes, ratings and compare, at the
 * Preferences dialog's size. "The drop down should be
 * considered a quick convenience while the pop out window is
 * something meant for more serious reviews."*/
export const TAKES_LABEL = "takes";
export const TAKES_WIDTH = 820;
export const TAKES_HEIGHT = 620;
export const BEND_LABEL = "bend";
export const CONSOLE_LABEL = "console";

/** Console entries crossing between windows: the main window taps the
 * app's logging and every window's Python runs land here, so the
 * popped-out console shows the same scrollback the in-app one does. */
export const CONSOLE_LOG_CHANNEL = "heeler:console-log";
export const CONSOLE_PY_CHANNEL = "heeler:console-py";

/** Channels the transport's own debug lines must never mention. The
 * log channel carries every log line between windows: a debug line
 * about sending one creates another to send, an unbounded chain. The
 * Python channel rides the same console and stays quiet with it. */
export const TRANSPORT_DEBUG_QUIET = new Set([CONSOLE_LOG_CHANNEL, CONSOLE_PY_CHANNEL]);

/** The frame currently on screen, pushed to whichever window wants it.
 *
 * A pop-out renders no photograph of its own: the engine and the graph
 * live in the main window. The spectrums plot this frame and the color
 * wheel samples it for its cloud, so it is one channel rather than one
 * per window. */
export const FRAME_CHANNEL = "heeler:frame";

/** A pop-out asking for a frame.
 *
 * Without it the window is only fed when the preview next changes, which
 * on a photograph nobody is editing is never: it would sit saying it was
 * waiting, correctly and forever. */
export const FRAME_REQUEST = "heeler:frame-request";

/** Which role this window is playing.
 *
 * In a browser the query string decides, because window.open is all we
 * have. Inside Tauri the window's label decides: a query string cannot
 * be carried on a WebviewUrl::App path without being encoded into the
 * path itself, which loads a 404 and leaves a blank window. Falling back
 * to "main" on any failure is the safe direction, since the main window
 * is the one that can open another. */
export async function resolveWindowRole(): Promise<WindowRole> {
  const fromQuery = windowRole();
  if (fromQuery !== "main") return fromQuery;
  if (!isTauri()) return "main";
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const label = getCurrentWindow().label;
    if (label === GRAPH_LABEL) return "graph";
    if (label === SPECTRUM_LABEL) return "spectrum";
    if (label === TAKES_LABEL) return "takes";
    if (label === BEND_LABEL) return "bend";
    if (label === CONSOLE_LABEL) return "console";
    if (label in TOOL_WINDOWS) return label as ToolWindowKind;
    return "main";
  } catch {
    return "main";
  }
}

/** 16:9, because that is the shape of the thing being measured.
 *
 * A waveform is the frame squeezed sideways, so a window shaped like a
 * frame reads as one. The Rust side holds the window to this ratio while
 * it is dragged; this is the size it starts at. */
export const SPECTRUM_ASPECT = 16 / 9;
const SPECTRUM_WIDTH = 960;
const SPECTRUM_HEIGHT = Math.round(SPECTRUM_WIDTH / SPECTRUM_ASPECT);

const openers = new Map<string, { element: HTMLElement; testid?: string }>();
function rememberOpener(role: string, element: Element | null = document.activeElement) {
  if (openers.has(role) || !(element instanceof HTMLElement)) return;
  openers.set(role, {element, testid: element.dataset.testid});
}
/** Remember the supplied or focused control as the opener, for the focus
 * to come back to when the window docks, without opening anything.
 *
 * For a control that opens a pop-out by setting its flag: the flag's
 * effect opens the window, and this keeps the control from the click.
 * The button used to open the window itself as well, for that focus,
 * and the two opens raced on the Rust side: the second found no
 * window yet, built, and failed with the label taken, which the
 * effect read as a failed open and closed the window the first had
 * made (2026-09-15: "The graph popout flashes open and closes
 * again"). One opener, and nothing to race.*/
export function rememberPopoutOpener(role: WindowRole, element?: HTMLElement | null) {
  // A menu item disappears on activation; its menu button survives docking.
  rememberOpener(role, element);
}
export function restorePopoutFocus(role: string) {
  const opener = openers.get(role);
  if (!opener) return;
  openers.delete(role);
  requestAnimationFrame(() => {
    const element = opener.element.isConnected ? opener.element : opener.testid
      ? document.querySelector<HTMLElement>(`[data-testid="${CSS.escape(opener.testid)}"]`) : null;
    element?.focus();
    if (isTauri()) void import("@tauri-apps/api/window").then(({getCurrentWindow}) => getCurrentWindow().setFocus()).catch(() => {});
  });
}

/** What the Rust side says opening a pop-out did (PopoutOpened in
 * lib.rs). A rejection from the command means the window does not
 * exist; this arrives when it does, with a note if it could not be
 * shown or focused. */
export interface PopoutOpened {
  existed: boolean;
  note: string | null;
}

/** Opens a pop-out through the Rust side and keeps a presentation
 * failure from reading as a failed open. followPopout answers a
 * rejection by clearing the window's flag, and the flag's fall closes
 * the window, so a window that exists but would not come forward
 * used to be closed for it (review 2026-09-15). Now the window stays,
 * and the note goes to the log and the status line. */
async function openNative(command: string, name: string, args?: Record<string, unknown>): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  reportPresentation(name, await invoke<PopoutOpened>(command, args));
}

/** The note, if any, as a warning: the window is open, which is what
 * the flag records; that it did not come forward is worth a line. */
export function reportPresentation(name: string, opened: PopoutOpened): void {
  if (!opened.note) return;
  const message = `${name} window is open but ${opened.note}`;
  logMsg("warn", message);
  flashStatus(message, 6000);
}

export async function openSpectrumWindow(): Promise<void> {
  rememberOpener("spectrum");
  if (isTauri()) {
    await openNative("open_popout", "Spectrums", {
      label: SPECTRUM_LABEL,
      title: "Heeler Spectrums",
      width: SPECTRUM_WIDTH,
      height: SPECTRUM_HEIGHT,
    });
    return;
  }
  openBrowserPopout(
    "spectrum",
    "heeler-spectrum",
    `width=${SPECTRUM_WIDTH},height=${SPECTRUM_HEIGHT}`,
  );
}

/** The color wheel in a window of its own.
 *
 * "It can be tricky to do finer edits... a button that pops
 * this out into a larger floating window I can drag around. Like 2x
 * larger." Square, because the wheel is: a wide window would be a wheel
 * with empty space either side of it.
 */
const BEND_SIZE = 720;

export async function openBendWindow(): Promise<void> {
  rememberOpener("bend");
  if (isTauri()) {
    await openNative("open_popout", "Color Bend", {
      label: BEND_LABEL,
      title: "Heeler Color Bend",
      width: BEND_SIZE,
      height: BEND_SIZE,
    });
    return;
  }
  openBrowserPopout("bend", "heeler-bend", `width=${BEND_SIZE},height=${BEND_SIZE}`);
}

/** The console in a window of its own. "I would like to be
 * able to drag that console window outside of the main window." A
 * floating div cannot leave its webview; an OS window can.*/
const CONSOLE_W = 820;
const CONSOLE_H = 480;

let browserConsole: Window | null = null;

export async function openConsoleWindow(x?: number, y?: number): Promise<void> {
  rememberOpener("console");
  if (isTauri()) {
    await openNative("open_popout", "Console", {
      label: CONSOLE_LABEL,
      title: "Heeler Console",
      width: CONSOLE_W,
      height: CONSOLE_H,
      x: x ?? null,
      y: y ?? null,
    });
    return;
  }
  // An open Console is raised, never opened again: window.open with the
  // same name LOADS the page anew in that window, which would throw away
  // everything the Console holds.
  if (browserConsole && !browserConsole.closed) {
    browserConsole.focus();
    return;
  }
  browserConsole = window.open(
    `${location.pathname}?view=console`,
    "heeler-console",
    `width=${CONSOLE_W},height=${CONSOLE_H}` +
      (x !== undefined && y !== undefined ? `,left=${Math.max(0, x)},top=${Math.max(0, y)}` : ""),
  );
  if (browserConsole === null) throw new Error("Allow pop-ups for Heeler, then try again");
}

export async function closeConsoleWindow(): Promise<void> {
  restorePopoutFocus("console");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_popout", { label: CONSOLE_LABEL });
    return;
  }
  browserConsole?.close();
  browserConsole = null;
}

/** Browser handles for the pop-outs, one per window name. The console
 * above keeps its own for the same reason: without a handle, the
 * browser transport can open a window it can never close or raise, so
 * docking from the panel left the popup on screen and re-popping opened
 * a second copy instead of calling the first one back. Dev-server-only;
 * the Tauri paths never reach these. */
const browserPopouts = new Map<string, Window | null>();

function openBrowserPopout(view: string, name: string, features: string): void {
  const existing = browserPopouts.get(name);
  if (existing && !existing.closed) {
    // window.open reuses a same-named window but does not raise it, and
    // "lost windows come when called" is the whole point of re-popping.
    existing.focus();
    return;
  }
  const popup = window.open(`${location.pathname}?view=${view}`, name, features);
  if (popup === null) throw new Error("Allow pop-ups for Heeler, then try again");
  browserPopouts.set(name, popup);
}

function closeBrowserPopout(name: string): void {
  const w = browserPopouts.get(name);
  // Already closed by its own chrome is success, same as the Rust side.
  if (w && !w.closed) w.close();
  browserPopouts.delete(name);
}

export async function openToolWindow(kind: ToolWindowKind): Promise<void> {
  rememberOpener(kind);
  const spec = TOOL_WINDOWS[kind];
  if (isTauri()) {
    await openNative("open_popout", spec.title.replace(/^Heeler /, ""), {
      label: kind,
      title: spec.title,
      width: spec.width,
      height: spec.height,
    });
    return;
  }
  openBrowserPopout(kind, `heeler-${kind}`, `width=${spec.width},height=${spec.height}`);
}

export async function closeToolWindow(kind: ToolWindowKind): Promise<void> {
  restorePopoutFocus(kind);
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_popout", { label: kind });
    return;
  }
  closeBrowserPopout(`heeler-${kind}`);
}

export async function closeBendWindow(): Promise<void> {
  restorePopoutFocus("bend");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_popout", { label: BEND_LABEL });
    return;
  }
  closeBrowserPopout("heeler-bend");
}

export async function openTakesWindow(): Promise<void> {
  rememberOpener("takes");
  if (isTauri()) {
    await openNative("open_popout", "Takes", {
      label: TAKES_LABEL,
      title: "Heeler Takes",
      width: TAKES_WIDTH,
      height: TAKES_HEIGHT,
    });
    return;
  }
  openBrowserPopout("takes", "heeler-takes", `width=${TAKES_WIDTH},height=${TAKES_HEIGHT}`);
}

export async function closeTakesWindow(): Promise<void> {
  restorePopoutFocus("takes");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_popout", { label: TAKES_LABEL });
    return;
  }
  closeBrowserPopout("heeler-takes");
}

export async function closeSpectrumWindow(): Promise<void> {
  restorePopoutFocus("spectrum");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_popout", { label: SPECTRUM_LABEL });
    return;
  }
  closeBrowserPopout("heeler-spectrum");
}

/** Everything the graph surface needs, minus the parts that are large and
 * irrelevant to it: the other images' saved graphs and the undo stacks. */
export type GraphSnapshot = Omit<State, "graphs" | "undoStack" | "redoStack">;

export function graphSnapshot(s: State): GraphSnapshot {
  const { graphs: _g, undoStack: _u, redoStack: _r, ...rest } = s;
  return { ...rest, images: withoutThumbnails(s) };
}

/** The library list with the thumbnails taken out of it.
 *
 * Every thumbnail the library has loaded lives in `images[].src` as a
 * base64 data URL, twenty-odd kilobytes each. A folder a few hundred
 * photographs deep is therefore several megabytes of state, and this
 * snapshot goes out on EVERY change: once per mousemove while a handle is
 * being dragged. Serializing a folder of thumbnails sixty times a second
 * to send it to a window drawing a color wheel is most of the cost of
 * having the window open at all.
 *
 * Only the open photograph's survives, because the graph window shows it
 * beside the node cards. Nothing else in either pop-out draws a thumb.
 */
function withoutThumbnails(s: State): State["images"] {
  return s.images.map((img) =>
    img.src && img.id !== s.activeImage ? { ...img, src: "" } : img,
  );
}

/** Rebuilds a State the graph surface can render from a snapshot. The
 * dropped fields are restored as empties: nothing on the graph surface
 * reads them, and a missing key would crash a lookup. */
export function applySnapshot(base: State, snap: GraphSnapshot): State {
  return {
    ...base,
    ...snap,
    graphs: base.graphs,
    undoStack: [],
    redoStack: [],
  };
}

/** Tauri events, which reach every window in the app. */
function tauriTransport(): Transport {
  const api = import("@tauri-apps/api/event");
  // Tauri's emit delivers to every window INCLUDING the sender, where
  // BroadcastChannel (the browser transport) never echoes to self. The
  // log store trusted the browser rule and ingested its own broadcasts
  // as a second copy of every line, which the console's replay then
  // showed. "Why does the About info print twice in the
  // console?" Every payload is enveloped with the sender's mark, and the
  // sender drops its own on the way in; a bare payload (from a window
  // built before the envelope) still passes through.
  const self =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
  return {
    send(channel, payload) {
      // Byte length only, never the payload: a graph snapshot is
      // megabytes, and this fires per reducer change during drags. And
      // NEVER the log channel: every debug line broadcasts over it, so
      // logging that send logs a line that broadcasts, which logs a line,
      // forever. On flipping DEBUG on: "immediately 3000 of these... I
      // can't clear all these messages."
      if (!TRANSPORT_DEBUG_QUIET.has(channel)) {
        logDebug(() => `transport send ${channel} (${JSON.stringify(payload)?.length ?? 0}b)`);
      }
      void api.then(({ emit }) => emit(channel, { __from: self, payload }));
    },
    subscribe(channel, fn) {
      // Through the event hub (taurievents.ts): a window's subscriptions
      // come and go with its components, the Tauri listener does not.
      return onTauriEvent<unknown>(channel, (payload) => {
          const p = payload as { __from?: string; payload?: unknown } | null;
          if (p && typeof p === "object" && "__from" in p) {
            if (p.__from !== self) fn(p.payload);
            // Dropping our own broadcast is the double-About fix; a
            // regression here duplicates every log line, so the drop
            // says so where a debug session can see it. The log
            // channel is exempt for the same reason send exempts it.
            else if (!TRANSPORT_DEBUG_QUIET.has(channel)) {
              logDebug(() => `transport ${channel}: dropped own echo`);
            }
          } else {
            fn(payload);
          }
      });
    },
  };
}

/** Same-origin windows opened with window.open share a BroadcastChannel,
 * so the dev server gets the real two-window behavior. */
function browserTransport(): Transport {
  const chans = new Map<string, BroadcastChannel>();
  const chan = (name: string) => {
    let c = chans.get(name);
    if (!c) {
      c = new BroadcastChannel(name);
      chans.set(name, c);
    }
    return c;
  };
  return {
    send(channel, payload) {
      chan(channel).postMessage(payload);
    },
    subscribe(channel, fn) {
      // A dedicated channel per subscriber: closing one listener must not
      // tear down the shared sender.
      const c = new BroadcastChannel(channel);
      const handler = (e: MessageEvent) => fn(e.data);
      c.addEventListener("message", handler);
      return () => {
        c.removeEventListener("message", handler);
        c.close();
      };
    },
  };
}

/** No windows to talk to (jsdom, or a browser without BroadcastChannel):
 * everything is dropped, which is the correct no-op. */
function nullTransport(): Transport {
  return { send() {}, subscribe: () => () => {} };
}

let cached: Transport | null = null;

export function transport(): Transport {
  if (!cached) {
    cached = isTauri()
      ? tauriTransport()
      : typeof BroadcastChannel !== "undefined"
        ? browserTransport()
        : nullTransport();
  }
  return cached;
}

/** Test seam: swap in a fake transport (pass null to restore). */
export function setTransport(t: Transport | null) {
  cached = t;
}

export function sendCommand(cmd: Command) {
  transport().send(CMD_CHANNEL, cmd);
}

/** Commands another window sends that open something here for the user
 * to see (the Help viewer at a chapter, Preferences): this window comes
 * to the front for them, or the Help viewer opens behind the Console
 * that asked for it. */
export const RAISING_COMMANDS: ReadonlySet<Command["type"]> = new Set<Command["type"]>(["open_docs", "open_prefs"]);

/** Brings this window to the front: the OS window in the app, the tab
 * in a browser. Nothing is loaded or navigated. */
export function raiseThisWindow(): void {
  if (isTauri()) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setFocus())
      .catch(() => {});
    return;
  }
  try {
    window.focus();
  } catch {
    // A browser that refuses focus: the viewer still opened.
  }
}

/** Opens the graph window, or focuses it if it is already out. In the
 * browser this is a plain popup pointed at the same page. */
export async function openGraphWindow(): Promise<void> {
  rememberOpener("graph");
  if (isTauri()) {
    await openNative("open_graph_window", "Graph");
    return;
  }
  openBrowserPopout("graph", "heeler-graph", "width=1100,height=760");
}

export async function closeGraphWindow(): Promise<void> {
  restorePopoutFocus("graph");
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("close_graph_window");
    return;
  }
  closeBrowserPopout("heeler-graph");
}
