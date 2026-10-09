// The Console window: two tabs on one floating panel, and a third,
// ASSISTANT (ui/assistanttab.tsx), when the assistant is set up. LOG is the app's
// message buffer, copyable. PYTHON is a live interpreter wired to the
// scripting bridge: what you type here goes through the same commands
// and the same undo history as any external script, because it IS the
// same client (`heeler` is preloaded; `h = heeler.connect()`).

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Command } from "../state";
import { clearLog, getEntries, getLogLevel, logAsText, logMsg, logVersion, setLogLevel, subscribeLog } from "../log";
import { flashStatus } from "./hints";
import { isMac, modLabel } from "../platform";
import {
  pickScript,
  pickScriptSave,
  pyExec,
  pyReset,
  readScript,
  writeScript,
  type PyResult,
  saveConsoleLog,
} from "../bridge";
import { closeConsoleWindow, openConsoleWindow } from "../popout";
import { MacInset } from "./chrome";
import { assistantConfig, assistantConfigVersion, assistantReady, subscribeAssistantConfig } from "../assistant";
import { AssistantTab, clearAssistantConversation } from "./assistanttab";
import { onRevealAssistant } from "../assistantchat";
import { MenuField } from "./menufield";

/** The log's level filter, widest first. */
const LOG_LEVELS = [
  { id: "all", label: "All levels" },
  { id: "info", label: "Info and up" },
  { id: "warn", label: "Warn and up" },
  { id: "error", label: "Errors only" },
];

const LEVEL_COLOR = { error: "#e88a7a", warn: "var(--warn)", info: "var(--text-mid)", debug: "var(--text-ghost)" } as const;

/** The header chips wear icons, not words ("Replace the
 * labels on Debug, Copy all, and Clear with icons... Echo, Reset,
 * and Clear"); every meaning still lives in the aria-label and the
 * status-line hint. One tiny stroke-style set, shared by both tabs.*/
function ChipIcon({ d, extra }: { d: string; extra?: React.ReactNode }) {
  return (
    // 12 x 1.15 ("scale up the icons (without scaling the
    // buttons) by 1.15x"): the chips keep their padding, only the glyph
    // grows.
    <svg width="13.8" height="13.8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d={d} />
      {extra}
    </svg>
  );
}
const ICONS = {
  // A bug: body, head, legs.
  bug: "M12 8a4 4 0 0 1 4 4v3a4 4 0 0 1-8 0v-3a4 4 0 0 1 4-4zM9 9l-2-2M15 9l2-2M8 13H5M8 17l-2 2M16 13h3M16 17l2 2",
  // Two sheets: copy.
  copy: "M9 9h10v11H9zM5 15V4h10",
  // A check: copied.
  check: "M5 13l4 4L19 7",
  // A struck circle: clear the scrollback.
  clear: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM6.5 6.5l11 11",
  // Sound waves off a point: echo.
  echo: "M6 12h.01M10 8a6 6 0 0 1 0 8M14 5a10 10 0 0 1 0 14",
  // A circular arrow: restart the session.
  reset: "M19 12a7 7 0 1 1-2-4.9M17 3v4.3h-4.3",
  // A play triangle: run the tab.
  run: "M8 5l11 7-11 7z",
  // An open folder: load a script.
  open: "M3 19V5h6l2 2h10v3M3 19l3.2-8H22l-3 8z",
  // The floppy that has meant save since before floppies went away.
  save: "M5 3h11l3 3v15H5zM8 3v5h7V3M8 21v-7h8v7",
  // The floppy again, a plus riding its corner: save under a new name.
  saveAs: "M4 3h9l3 3v12H4zM7 3v4h5V3M7 18v-5h6M19 14v7M15.5 17.5h7",
} as const;

// ---------------------------------------------------------------------
// The Python session lives at module level, like the log: closing the
// panel or switching tabs must not amnesia the scrollback, because the
// interpreter underneath keeps its namespace either way.

export interface PyEntry {
  kind: "in" | "out" | "err" | "val" | "echo";
  text: string;
}

const pyEntries: PyEntry[] = [];
const pyListeners = new Set<() => void>();
let pyVer = 0;
let pyBusy = false;

function pyNotify(): void {
  pyVer += 1;
  pyListeners.forEach((l) => l());
}

function pushPy(kind: PyEntry["kind"], text: string): void {
  if (!text) return;
  pyEntries.push({ kind, text });
  pyNotify();
  broadcastPy?.({ entry: { kind, text } });
}

interface PySyncPayload {
  entry?: PyEntry;
  clear?: boolean;
  /** the echo toggle, kept agreeing across windows */
  echo?: boolean;
  /** the popped-out console announcing itself (true) or leaving (false) */
  window?: boolean;
}

let broadcastPy: ((payload: PySyncPayload) => void) | null = null;
let pySyncSubscribed = false;

// ---------------------------------------------------------------------
// Echo (see echo.ts for the translation): module state like the
// scrollback, because it describes the console, not any one mount.
//
// The gate the dispatch tap checks is echoEnabled && a console actually
// showing; when neither the panel nor the console window is up, the tap does
// not even translate. On a 3D package's version: "If you left echo on and
// closed the script edit it would still be verbose in the background and
// after awhile actually slow things down."

let echoOn = false;
/** Whether the popped-out console window is alive, as announced over
 * the sync channel. The panel's own openness lives in app state. */
let windowLive = false;

export function echoEnabled(): boolean {
  return echoOn;
}

export function consoleWindowLive(): boolean {
  return windowLive;
}

const windowListeners = new Set<(open: boolean) => void>();

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

function pyVersion(): number {
  return pyVer;
}

function subscribePy(cb: () => void): () => void {
  pyListeners.add(cb);
  return () => pyListeners.delete(cb);
}

function clearPy(): void {
  pyEntries.length = 0;
  pyNotify();
  broadcastPy?.({ clear: true });
}

function pushResult(r: PyResult): void {
  if (r.out) pushPy("out", r.out.replace(/\n$/, ""));
  if (r.err) pushPy("err", r.err.replace(/\n$/, ""));
  if (r.value !== null && r.value !== undefined) pushPy("val", r.value);
}

async function runPy(code: string, label?: string): Promise<void> {
  if (!code.trim() || pyBusy) return;
  pushPy("in", label ?? code);
  pyBusy = true;
  pyNotify();
  try {
    pushResult(await pyExec(code));
  } catch (e) {
    pushPy("err", String(e));
  } finally {
    pyBusy = false;
    pyNotify();
  }
}

async function resetPy(): Promise<void> {
  await pyReset();
  pushPy("out", "# session reset");
}

// ---------------------------------------------------------------------
// Scratchboard tabs, 3D-package style: several scripts open at
// once, each a tab over the one editor. The whole set persists to
// localStorage on every edit, so a crash or a close loses nothing.

interface ScratchTab {
  name: string;
  text: string;
  /** Where this tab lives on disk; null for an unsaved scratch. */
  path: string | null;
  /** The text as of the last load or save; the dirty dot compares. */
  saved: string | null;
}

const SCRATCH_KEY = "heeler.py.scratch";

function freshTab(): ScratchTab {
  const n = tabs?.length ? Math.max(0, ...tabs.map((t) => Number(t.name.match(/^Scratch (\d+)$/)?.[1] ?? 0))) + 1 : 1;
  return { name: `Scratch ${n}`, text: "", path: null, saved: null };
}

let tabs: ScratchTab[] = [{ name: "Scratch 1", text: "", path: null, saved: null }];
let activeTab = 0;

function restoreScratch(): void {
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
restoreScratch();

/** Test hook: re-runs the crash-recovery load against localStorage. */
export const _restoreScratchForTests = restoreScratch;

/** Synchronous on purpose: crash safety is the point, and the payload
 * is a handful of scripts, not an image. */
function persistScratch(): void {
  try {
    localStorage.setItem(SCRATCH_KEY, JSON.stringify({ tabs, active: activeTab }));
  } catch {
    // Storage full or denied: the in-memory session still works.
  }
}

function scratchChanged(): void {
  persistScratch();
  pyNotify();
}

function editActiveTab(text: string): void {
  tabs[activeTab] = { ...tabs[activeTab], text };
  scratchChanged();
}

function selectTab(i: number): void {
  activeTab = Math.min(Math.max(0, i), tabs.length - 1);
  scratchChanged();
}

function addTab(): void {
  tabs.push(freshTab());
  activeTab = tabs.length - 1;
  scratchChanged();
}

function closeTab(i: number): void {
  tabs.splice(i, 1);
  if (!tabs.length) tabs.push(freshTab());
  activeTab = Math.min(activeTab, tabs.length - 1);
  scratchChanged();
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

async function openScriptTab(): Promise<void> {
  try {
    const path = await pickScript();
    if (!path) return;
    const text = await readScript(path);
    tabs.push({ name: baseName(path), text, path, saved: text });
    activeTab = tabs.length - 1;
    scratchChanged();
  } catch (e) {
    pushPy("err", String(e));
  }
}

async function saveActiveTab(saveAs: boolean): Promise<void> {
  const tab = tabs[activeTab];
  try {
    const path = !saveAs && tab.path ? tab.path : await pickScriptSave();
    if (!path) return;
    await writeScript(path, tab.text);
    tabs[activeTab] = { ...tab, path, name: baseName(path), saved: tab.text };
    scratchChanged();
    pushPy("out", `# saved ${baseName(path)}`);
  } catch (e) {
    pushPy("err", String(e));
  }
}

async function runActiveTab(): Promise<void> {
  const tab = tabs[activeTab];
  await runPy(tab.text, `# run ${tab.name}`);
}

// ---------------------------------------------------------------------
// Syntax coloring: a small tokenizer, not a grammar. Comments, strings,
// numbers, keywords and builtins cover what a console line looks like;
// anything it misses stays body-colored, which is the safe failure.

const PY_KEYWORDS = new Set(
  ("False None True and as assert async await break class continue def del elif else except " +
    "finally for from global if import in is lambda nonlocal not or pass raise return try " +
    "while with yield").split(" ")
);
const PY_BUILTINS = new Set(
  ("print len range repr str int float bool dict list set tuple open enumerate zip min max " +
    "sum abs round sorted reversed type isinstance getattr setattr hasattr dir help heeler h").split(" ")
);

const PY_COLOR = {
  keyword: "#c792ea",
  builtin: "#82aaff",
  string: "#c3e88d",
  number: "#e0a247",
  comment: "#6b7076",
} as const;

const PY_TOKEN =
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

function PySpans({ code }: { code: string }) {
  return (
    <>
      {highlightPython(code).map((s, i) => (
        <span key={i} style={{ color: s.color ?? "var(--text-body)" }}>
          {s.text}
        </span>
      ))}
    </>
  );
}

const MONO: React.CSSProperties = {
  fontFamily: "Consolas, ui-monospace, monospace",
  fontSize: 11,
  lineHeight: 1.6,
};

/** The scratchboard's run key by the platform's name: the Mac's
 * Command, CTRL elsewhere (docs review 2026-10-01: the Run button said
 * Ctrl+Enter on a Mac too). The editor's key handler takes Enter with
 * Command or Control, so the key named is the key bound. */
export function runKeyName(): string {
  return `${modLabel("ctrl")}${isMac() ? "" : "+"}Enter`;
}

/** The scratchboard: a transparent textarea over a highlighted mirror.
 * The textarea owns typing, caret and selection; the <pre> underneath
 * owns the colors. Identical metrics keep the two in register.
 *
 * This is an editor, not a command line. Code stays put across runs so
 * functions and loops can be written once and exercised repeatedly:
 * highlight a stretch and Cmd+Enter (Ctrl+Enter off a Mac) runs it;
 * with nothing highlighted
 * it runs the line under the caret. Enter is just a newline (with the
 * previous line's indent, plus a step after a colon), Tab indents. */
function PyEditor({
  value,
  onChange,
  onRun,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onRun: (code: string) => void;
  disabled: boolean;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  // A controlled textarea resets the caret when its value is set from
  // code, so edits that insert text carry their caret with them.
  const caretTo = useRef<number | null>(null);
  useEffect(() => {
    if (caretTo.current !== null && taRef.current) {
      taRef.current.setSelectionRange(caretTo.current, caretTo.current);
      caretTo.current = null;
    }
  }, [value]);
  const insert = (el: HTMLTextAreaElement, text: string) => {
    const a = el.selectionStart;
    const b = el.selectionEnd;
    caretTo.current = a + text.length;
    onChange(el.value.slice(0, a) + text + el.value.slice(b));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const a = el.selectionStart;
      let code = el.value.slice(a, el.selectionEnd);
      if (!code.trim()) {
        const from = el.value.lastIndexOf("\n", a - 1) + 1;
        const upTo = el.value.indexOf("\n", a);
        code = el.value.slice(from, upTo === -1 ? el.value.length : upTo);
      }
      if (code.trim() && !disabled) onRun(code);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const lineStart = el.value.lastIndexOf("\n", el.selectionStart - 1) + 1;
      const line = el.value.slice(lineStart, el.selectionStart);
      const indent = (line.match(/^[ \t]*/)?.[0] ?? "") + (line.trimEnd().endsWith(":") ? "    " : "");
      insert(el, "\n" + indent);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      insert(el, "    ");
    }
  };

  const shared: React.CSSProperties = {
    ...MONO,
    margin: 0,
    padding: "6px 8px",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    border: "none",
  };
  return (
    <div style={{ position: "relative", height: 130 }}>
      <pre
        ref={preRef}
        aria-hidden
        style={{ ...shared, position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
      >
        <PySpans code={value} />
        {"\n"}
      </pre>
      <textarea
        ref={taRef}
        data-testid="py-input"
        aria-label="Python scratchboard"
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          if (preRef.current) preRef.current.scrollTop = e.currentTarget.scrollTop;
        }}
        style={{
          ...shared,
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          resize: "none",
          overflowY: "auto",
          background: "transparent",
          color: "transparent",
          caretColor: "var(--text-hi)",
          outline: "none",
        }}
      />
    </div>
  );
}

const PY_ENTRY_COLOR: Record<PyEntry["kind"], string> = {
  in: "var(--text-ghost)",
  out: "var(--text-body)",
  err: "#e88a7a",
  val: "#82aaff",
  echo: "var(--text-faint)",
};

function PythonTab() {
  useSyncExternalStore(subscribePy, pyVersion, pyVersion);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  const tab = tabs[activeTab];
  return (
    <>
      <div
        ref={scrollRef}
        data-testid="py-output"
        style={{ flex: 1, overflowY: "auto", padding: "6px 12px", ...MONO, WebkitUserSelect: "text", userSelect: "text", cursor: "text" }}
      >
        {pyEntries.length === 0 && (
          <div style={{ color: "var(--text-ghost)" }}>
            Python console, already connected to this session:{" "}
            <span style={{ color: PY_COLOR.builtin }}>heeler</span> is imported and{" "}
            <span style={{ color: PY_COLOR.builtin }}>heeler.nodes()</span> lists the open
            photograph's nodes. Write in the scratchboard below; highlight code and {runKeyName()}
            runs it, with nothing highlighted it runs the caret's line.
          </div>
        )}
        {pyEntries.map((e, i) => (
          <div key={i} data-testid={`py-${e.kind}`} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {e.kind === "in" ? (
              <>
                <span style={{ color: "var(--text-ghost)" }}>{">>> "}</span>
                <PySpans code={e.text} />
              </>
            ) : e.kind === "echo" ? (
              // Echoed UI actions: syntax-colored like typed code, dot
              // instead of a prompt, so what you did and what you typed
              // stay tellable apart and both stay copy-pasteable.
              <>
                <span style={{ color: "var(--text-ghost)" }}>{"  · "}</span>
                <PySpans code={e.text} />
              </>
            ) : (
              <span style={{ color: PY_ENTRY_COLOR[e.kind] }}>{e.text}</span>
            )}
          </div>
        ))}
        {pyBusy && <div style={{ color: "var(--text-ghost)" }}>…</div>}
      </div>
      <div style={{ borderTop: "1px solid var(--line-2)", background: "rgba(0,0,0,.18)" }}>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 4, padding: "3px 6px",
            borderBottom: "1px solid var(--line-2)",
          }}
        >
          {tabs.map((t, i) => (
            <button
              key={i}
              data-testid={`py-tab-${i}`}
              onClick={() => selectTab(i)}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                // The chosen-state language every pressed chip in the
                // app speaks: accent lettering, accent outline, the
                // tint behind it. Off-tabs stay ghost with an invisible
                // border of the same width so selection never reflows.
                background: i === activeTab ? "var(--accent-tint)" : "none",
                border: "1px solid " + (i === activeTab ? "var(--accent)" : "transparent"),
                padding: "2px 8px", cursor: "pointer", fontSize: 10,
                color: i === activeTab ? "var(--accent)" : "var(--text-ghost)",
              }}
            >
              {t.path && t.saved !== t.text ? "• " : ""}
              {t.name}
              {tabs.length > 1 && i === activeTab && (
                <span
                  data-testid="py-tab-close"
                  aria-label={`Close ${t.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(i);
                  }}
                  style={{ color: "var(--text-ghost)" }}
                >
                  ✕
                </span>
              )}
            </button>
          ))}
          <button
            data-testid="py-tab-add"
            aria-label="New scratch tab"
            onClick={addTab}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-ghost)", fontSize: 12, padding: "0 4px" }}
          >
            +
          </button>
          <div style={{ flex: 1 }} />
          {/* Icons with tooltip names, same as the header chips
("make icons for the Run, Open..., Save, and Save as... buttons and
make sure the buttons have tool tips"): the aria-label IS the
tooltip, via the panel's delegated hover.*/}
          <button
            className="chip"
            data-testid="py-run-tab"
            aria-label={`Run the tab (${runKeyName()} runs highlighted lines)`}
            onClick={() => void runActiveTab()}
          >
            <ChipIcon d={ICONS.run} />
          </button>
          <button
            className="chip"
            data-testid="py-open"
            aria-label={"Open a script\u2026"}
            onClick={() => void openScriptTab()}
          >
            <ChipIcon d={ICONS.open} />
          </button>
          <button className="chip" data-testid="py-save" aria-label="Save" onClick={() => void saveActiveTab(false)}>
            <ChipIcon d={ICONS.save} />
          </button>
          <button
            className="chip"
            data-testid="py-save-as"
            aria-label={"Save as\u2026"}
            onClick={() => void saveActiveTab(true)}
          >
            <ChipIcon d={ICONS.saveAs} />
          </button>
        </div>
        <PyEditor value={tab.text} onChange={editActiveTab} onRun={(code) => void runPy(code)} disabled={pyBusy} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------

export function ConsolePanel({
  open,
  dispatch,
  windowed = false,
}: {
  open: boolean;
  dispatch: React.Dispatch<Command>;
  /** Filling its own OS window rather than floating over the app. */
  windowed?: boolean;
}) {
  useSyncExternalStore(subscribeLog, logVersion, logVersion);
  // The python store too: the ECHO chip's lit state lives there.
  useSyncExternalStore(subscribePy, pyVersion, pyVersion);
  const entries = getEntries();
  const [chosenTab, setTab] = useState<"log" | "python" | "assistant">("log");
  // A question the main window asked for the user (a Learn more or a
  // follow-up typed on the tour's end card): its answer is here.
  useEffect(() => onRevealAssistant(() => setTab("assistant")), []);
  // The Assistant tab is there only while the assistant is on and saved
  // with a validated address and model: it only answers questions, and
  // anything that would change the edit goes through the reducer.
  useSyncExternalStore(subscribeAssistantConfig, assistantConfigVersion, assistantConfigVersion);
  const assistantOn = assistantReady(assistantConfig());
  const tab = chosenTab === "assistant" && !assistantOn ? "log" : chosenTab;
  // The log view's filters, display-only: Copy all still copies the
  // whole buffer, because a bug report wants everything (the audit's
  // gap: "with 3,000 entries and a debug session's volume, the console
  // needs a level filter and probably a substring filter").
  const [levelFilter, setLevelFilter] = useState<"all" | "info" | "warn" | "error">("all");
  const [logQuery, setLogQuery] = useState("");
  // A tooltip beside the mouse for every labeled button
  // ("Add a tool tip that pops up next to the mouse with the name of
  // each button (since the console doesn't have a status line)"). Fed
  // by aria-label, so a button cannot have a name the tooltip misses.
  //
  // Coordinates are corrected by the MEASURED scale of the panel, not
  // an assumed chrome-zoom: whether this window's engine scales fixed
  // elements inside a ui-zoom subtree or lets them escape it, the tip
  // and the panel share a positioning context, so painted width over
  // layout width is the exact factor in force. Assuming 1.15 put the
  // tip adrift of the cursor ("The tools tips are not
  // aligning correctly to the mouse cursor").
  const [tip, setTip] = useState<{ text: string; x: number; y: number; flip: boolean } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const onTipMove = (e: React.MouseEvent) => {
    const el = (e.target as Element).closest?.("button[aria-label]");
    const text = el?.getAttribute("aria-label") ?? null;
    if (!text) {
      if (tip) setTip(null);
      return;
    }
    const panel = panelRef.current;
    const scale =
      panel && panel.offsetWidth > 0
        ? panel.getBoundingClientRect().width / panel.offsetWidth
        : 1;
    const cx = e.clientX / scale;
    const cy = e.clientY / scale;
    // Near the right edge the tip FLIPS to the cursor's other side. The
    // flip itself is translateX(-100%), the element's own real width, so
    // no estimate ever decides POSITION: estimating the width and
    // subtracting it put the tip a guess-error away from the cursor (The
    // report: "Look how far it is from the run button"). The estimate
    // below only picks the side, where being off by a little just flips a
    // borderline tip one hover early.
    const fits = cx + 12 + (text.length * 5.4 + 18) <= window.innerWidth / scale;
    setTip({ text, x: cx, y: cy + 16, flip: !fits });
  };
  const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 } as const;
  const shownEntries = entries.filter(
    (e) =>
      (levelFilter === "all" || LEVEL_RANK[e.level] >= LEVEL_RANK[levelFilter]) &&
      (logQuery === "" || e.message.toLowerCase().includes(logQuery.toLowerCase())),
  );
  // Copy feedback, in the button itself: the console can live in a
  // pop-out window where the status bar is not, and a copy that says
  // nothing reads as a dead button. "the Copy All button
  // gives no feedback that the data was copied."
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  // The popped-out console announces itself, so the main window's echo
  // tap knows a console is showing, and stops translating the moment
  // this window goes away.
  useEffect(() => {
    if (!windowed) return;
    announceConsoleWindow(true);
    const bye = () => announceConsoleWindow(false);
    window.addEventListener("beforeunload", bye);
    return () => {
      window.removeEventListener("beforeunload", bye);
      announceConsoleWindow(false);
    };
  }, [windowed]);
  if (!open) return null;
  // The console IS a window, full stop. It spent a long time as a
  // floating panel that converted to an OS window when dragged out, and
  // every version of that conversion was a compromise: a div cannot draw
  // past the webview, so something always clipped or jumped.
  // "I really hate how it spawns as one window and transforms to another
  // when I drag. That is awful UI design. It always needs to spawn as an
  // OS window." So it does; this component only ever fills the window
  // that hosts it.
  const frame: React.CSSProperties = {
    position: "fixed", inset: 0, zIndex: 120, background: "var(--bg-panel)",
    display: "flex", flexDirection: "column",
  };
  return (
    <div ref={panelRef} data-testid="console-panel" style={frame} onMouseMove={onTipMove} onMouseLeave={() => setTip(null)}>
      {tip && (
        <div
          data-testid="console-tip"
          style={{
            position: "fixed", left: tip.x, top: tip.y, zIndex: 200,
            // The 12px cursor gap rides inside the transform so the
            // flip mirrors it exactly.
            transform: tip.flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
            // The .3s animation delay is the hover grace: mousing
            // across the row does not strobe labels.
            animation: "tip-in .12s ease .3s both",
            pointerEvents: "none", whiteSpace: "nowrap",
            background: "var(--bg-panel-head)", border: "1px solid var(--line-4)",
            color: "var(--text-body)", fontSize: 10, padding: "3px 7px",
            boxShadow: "0 4px 14px rgba(0,0,0,.4)",
          }}
        >
          {tip.text}
        </div>
      )}
      <div
        data-testid="console-drag"
        // Pop-outs are undecorated windows, so the header IS the
        // titlebar: Tauri's drag region moves the whole OS window, same
        // bargain the graph window makes.
        data-tauri-drag-region
        style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 12px", borderBottom: "1px solid var(--line-2)", background: "var(--bg-panel-head)", cursor: "move", userSelect: "none" }}>
        {windowed && <MacInset />}
        {(["log", "python", ...(assistantOn ? (["assistant"] as const) : [])] as const).map((t) => (
          <button
            key={t}
            data-testid={`console-tab-${t}`}
            onClick={() => setTab(t)}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              // The mode you are IN wears the accent, same as the
              // Develop/Graph/Canvas tabs: accent lettering over an
              // accent underline. The underline is always drawn (just
              // transparent when off) so switching never shifts layout.
              background: "none", border: "none", padding: "0 0 2px", cursor: "pointer",
              fontSize: 11, fontWeight: 600, letterSpacing: ".12em",
              color: tab === t ? "var(--accent)" : "var(--text-ghost)",
              borderBottom: "2px solid " + (tab === t ? "var(--accent)" : "transparent"),
            }}
          >
            {t === "log" ? "LOG" : t === "python" ? "PYTHON" : "ASSISTANT"}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        {tab === "log" ? (
          <>
            <MenuField
              testid="log-level-filter"
              label="Log level filter"
              value={levelFilter}
              options={LOG_LEVELS}
              fitLabels={LOG_LEVELS.map((l) => l.label)}
              onChange={(id) => setLevelFilter(id as "all" | "info" | "warn" | "error")}
            />
            <input
              aria-label="Filter log messages" data-testid="log-search"
              value={logQuery}
              placeholder={"Filter\u2026"}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setLogQuery(e.target.value)}
              style={{
                width: 120, background: "var(--bg-app)", border: "1px solid var(--line-4)",
                color: "var(--text-body)", fontSize: 10, padding: "2px 6px", outline: "none",
              }}
            />
            <button
              className="chip"
              data-testid="log-debug-toggle"
              data-active={getLogLevel() === "debug" || undefined}
              onMouseDown={(e) => e.stopPropagation()}
              data-hint="DEBUG verbosity: the seams report what they decide, for a bug report you can copy. Can slow the app down; resets to INFO at every launch."
              style={{
                color: getLogLevel() === "debug" ? "var(--accent)" : undefined,
                borderColor: getLogLevel() === "debug" ? "var(--accent-dim)" : undefined,
              }}
              aria-label="Debug verbosity"
              onClick={() => setLogLevel(getLogLevel() === "debug" ? "info" : "debug")}
            >
              <ChipIcon d={ICONS.bug} />
            </button>
            <button
              className="chip"
              data-testid="console-copy"
              style={copied ? { color: "var(--pick)", borderColor: "var(--pick)" } : undefined}
              onClick={() => {
                // Optional-chained CALL, not just member: without a
                // clipboard (tests, odd webviews) `?.writeText(...)`
                // still evaluated to undefined and `.then` threw.
                void navigator.clipboard?.writeText(logAsText())?.then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              aria-label="Copy the whole log"
              data-hint="Copy every line in the buffer, filters or not: a bug report wants the whole story"
            >
              <ChipIcon d={copied ? ICONS.check : ICONS.copy} />
            </button>
            <button
              className="chip"
              data-testid="console-save"
              style={saved ? { color: "var(--pick)", borderColor: "var(--pick)" } : undefined}
              aria-label="Save the log to a file"
              data-hint="Save every line in the buffer to a file of your choosing, as it is right now"
              onClick={() => {
                void saveConsoleLog(logAsText()).then((path) => {
                  if (!path) return;
                  logMsg("info", `Console saved to ${path}`);
                  setSaved(true);
                  window.setTimeout(() => setSaved(false), 1500);
                });
              }}
            >
              <ChipIcon d={saved ? ICONS.check : ICONS.save} />
            </button>
            <button
              className="chip"
              data-testid="console-clear"
              aria-label="Clear the log"
              data-hint="Empty the console scrollback"
              onClick={clearLog}
            >
              <ChipIcon d={ICONS.clear} />
            </button>
          </>
        ) : tab === "assistant" ? (
          <button
            className="chip"
            data-testid="assistant-clear"
            aria-label="Clear the conversation"
            data-hint="Starts a new conversation; this one was never saved anywhere"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={clearAssistantConversation}
          >
            <ChipIcon d={ICONS.clear} />
          </button>
        ) : (
          <>
            <button
              className="chip"
              data-testid="py-echo-toggle"
              data-active={echoEnabled() || undefined}
              onMouseDown={(e) => e.stopPropagation()}
              data-hint="Print the Python behind what you do in the UI, ready to paste into a script. Costs nothing while the console is closed."
              style={{
                color: echoEnabled() ? "var(--accent)" : undefined,
                borderColor: echoEnabled() ? "var(--accent-dim)" : undefined,
              }}
              aria-label="Echo UI actions as Python"
              onClick={() => setEcho(!echoEnabled())}
            >
              <ChipIcon d={ICONS.echo} />
            </button>
            <button
              className="chip"
              data-testid="py-reset"
              aria-label="Restart the Python session"
              data-hint="Restart the interpreter: every variable, function and import defined so far is gone"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => void resetPy()}
            >
              <ChipIcon d={ICONS.reset} />
            </button>
            <button
              className="chip"
              data-testid="py-clear"
              aria-label="Clear the scrollback"
              data-hint="Empty the scrollback text; the session and its variables stay"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={clearPy}
            >
              <ChipIcon d={ICONS.clear} />
            </button>
          </>
        )}
        <button
          className="chip"
          data-testid="console-close"
          aria-label="Close console"
          onClick={() => {
            // An undecorated OS window has no system close button; this
            // chip is it. The dispatch fallback serves tests and the
            // browser build, where the console may live in-page.
            void (async () => {
              try {
                const { getCurrentWindow } = await import("@tauri-apps/api/window");
                await getCurrentWindow().close();
              } catch {
                dispatch({ type: "toggle_console" });
                window.close();
              }
            })();
          }}
        >
          ✕
        </button>
      </div>
      {tab === "log" ? (
        <>
        <div
          style={{
            flex: 1, overflowY: "auto", padding: "6px 12px", ...MONO,
            WebkitUserSelect: "text", userSelect: "text", cursor: "text",
          }}
        >
          {shownEntries.length === 0 && (
            <div style={{ color: "var(--text-ghost)" }}>
              {entries.length === 0 ? "No messages." : "Nothing matches the filter."}
            </div>
          )}
          {shownEntries.map((e, i) => (
            <div key={i} data-testid="console-entry" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              <span className="tnum" style={{ color: "var(--text-ghost)" }}>[{e.time}] </span>
              <span style={{ color: LEVEL_COLOR[e.level] }}>{e.level.toUpperCase()} </span>
              <span style={{ color: "var(--text-body)" }}>{e.message}</span>
            </div>
          ))}
        </div>
        {/* The count lives in a status bar of its own, not the title row: at
150% app scale the row ran out of width and "2 messages" wrapped onto
two lines between the tabs and the filters (2026-09-28, with a
screenshot: "maybe this view should have its own status bar for
messages").*/}
        <div
          data-testid="console-status"
          className="tnum"
          style={{
            flex: "none", padding: "3px 12px", fontSize: 11, whiteSpace: "nowrap",
            color: "var(--text-ghost)", background: "var(--bg-panel-head)",
          }}
        >
          {shownEntries.length === entries.length
            ? `${entries.length} ${entries.length === 1 ? "message" : "messages"}`
            : `${shownEntries.length} of ${entries.length} messages shown`}
        </div>
        </>
      ) : tab === "assistant" ? (
        <AssistantTab />
      ) : (
        <PythonTab />
      )}
    </div>
  );
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
