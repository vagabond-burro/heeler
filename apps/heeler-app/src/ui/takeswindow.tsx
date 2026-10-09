// The takes in a window of their own: the review desk.
//
// A thin client, the same shape as the spectrum window: no photograph,
// no engine; it reads the session snapshot the main window pushes and
// sends every edit home over the command channel. The dropdown in the
// viewer stays the quick switcher; this is where the notes are read and
// written, where each take wears stars on the thumbnails' scale, and
// where compare is picked with room to see what is being compared (The
// report: "The drop down should be considered a quick convenience while
// the pop out window is something meant for more serious reviews").
//
// Sized and typed like the Preferences dialog: the content box wears the
// chrome zoom, labels at 14, body at 13.5, kickers at 10.

import { useEffect, useRef, useState } from "react";
import { initialState } from "../data";
import type { Command, State, Take } from "../state";
import { MULTI_MAX } from "../state";
import {
  DOCK_CHANNEL,
  STATE_CHANNEL,
  STATE_REQUEST,
  TAKES_LABEL,
  applySnapshot,
  sendCommand,
  transport,
  type GraphSnapshot,
} from "../popout";
import { DockButton, MacInset, WindowControls } from "./chrome";
import { ActiveIcon, CompareIcon, TrashIcon } from "./takeicons";
import { useHintSource } from "./hints";
import { PopoutStatusRow } from "./popoutstatus";

/** The takes of the active photograph, the implicit first one included. */
export function takesOf(state: State): { takes: Take[]; activeId: string } {
  const takes: Take[] =
    state.takes[state.activeImage] ??
    ([{ id: "take_1", name: "Take 1", nodes: [], wires: [] }] as Take[]);
  return { takes, activeId: state.activeTakes[state.activeImage] ?? "take_1" };
}

/** Five stars on the thumbnails' scale. Clicking the star a take already
 * has clears the rating, the way the ribbon's stars do. */
function TakeStars({ take, dispatch }: { take: Take; dispatch: (c: Command) => void }) {
  const stars = take.rating ?? 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }} data-testid={`take-stars-${take.id}`} role="group" aria-label={`Rating for ${take.name}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          type="button"
          key={n}
          aria-pressed={n === stars}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          data-testid={`take-star-${take.id}-${n}`}
          data-on={n <= stars}
          data-hint={n === stars ? "Clear the rating" : `Rate this take ${n} star${n === 1 ? "" : "s"}`}
          onClick={() => dispatch({ type: "set_take_rating", takeId: take.id, rating: stars === n ? 0 : n })}
          style={{
            background: "none", border: "none", fontFamily: "inherit",
            fontSize: 16,
            lineHeight: 1,
            cursor: "pointer",
            padding: "1px 0",
            color: n <= stars ? "var(--accent)" : "var(--slot-empty)",
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/** A field that holds its own draft while it is being typed in and
 * writes home on blur (or Ctrl/Cmd+Enter): every keystroke over the
 * command channel would round-trip through the main window's reducer
 * and land back as a snapshot under the cursor. */
function DraftField({
  value,
  testid,
  placeholder,
  label,
  multiline,
  onCommit,
  style,
}: {
  value: string;
  testid: string;
  placeholder: string;
  label: string;
  multiline?: boolean;
  onCommit: (v: string) => void;
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const dirty = useRef(false);
  // A change that arrived from elsewhere (the dropdown's rename, another
  // window) shows here as long as nobody is mid-edit.
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    if (dirty.current && draft !== value) onCommit(draft);
    dirty.current = false;
  };
  const cancel = (input: HTMLInputElement | HTMLTextAreaElement) => {
    dirty.current = false;
    setDraft(value);
    input.blur();
  };
  const shared: React.CSSProperties = {
    background: "var(--bg-app)",
    border: "1px solid var(--line-4)",
    color: "var(--text-body)",
    padding: "6px 8px",
    outline: "none",
    fontFamily: "inherit",
    borderRadius: 3,
    ...style,
  };
  if (multiline) {
    return (
      <textarea
        data-testid={testid}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        rows={3}
        onFocus={() => setFocused(true)}
        onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.target as HTMLTextAreaElement).blur();
          if (e.key === "Escape") {
            cancel(e.currentTarget);
          }
        }}
        style={{ ...shared, fontSize: 13.5, lineHeight: 1.5, resize: "vertical", width: "100%", boxSizing: "border-box" }}
      />
    );
  }
  return (
    <input
      data-testid={testid}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          cancel(e.currentTarget);
        }
      }}
      style={{ ...shared, fontSize: 14, fontWeight: 600, minWidth: 0, flex: 1 }}
    />
  );
}

export function TakesWindow() {
  const [snap, setSnap] = useState<State | null>(null);
  useHintSource();

  useEffect(
    () =>
      transport().subscribe(STATE_CHANNEL, (payload: unknown) =>
        setSnap(applySnapshot(initialState(), payload as GraphSnapshot)),
      ),
    [],
  );

  // Ask until one lands, the cadence the other pop-outs use.
  useEffect(() => {
    if (snap) return;
    transport().send(STATE_REQUEST, true);
    const timer = setInterval(() => transport().send(STATE_REQUEST, true), 400);
    return () => clearInterval(timer);
  }, [snap]);

  const dispatch = (cmd: Command) => sendCommand(cmd);
  const state = snap;
  const { takes, activeId } = state ? takesOf(state) : { takes: [] as Take[], activeId: "take_1" };
  const photo = state?.images.find((i) => i.id === state.activeImage);

  return (
    <div className="app" data-testid="takes-window">
      <div
        className="titlebar"
        data-tauri-drag-region
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 0 0 12px" }}
      >
        <MacInset />
        <div className="kicker" style={{ letterSpacing: ".16em" }} data-tauri-drag-region>
          Heeler Takes
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DockButton testid="takes-dock" hint="Close the Takes window" onClick={() => transport().send(DOCK_CHANNEL, TAKES_LABEL)} />
          <WindowControls />
        </div>
      </div>
      {/* Zoom on the content box, never the window root: the same rule
          the Preferences dialog follows. */}
      <div className="ui-zoom" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "14px 18px 18px", gap: 12, overflow: "hidden" }}>
        {!state ? (
          <div data-testid="takes-window-waiting" className="kicker" style={{ fontSize: 10, letterSpacing: ".14em", padding: 8 }}>
            WAITING FOR THE MAIN WINDOW
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 14, color: "var(--text-hi)", fontWeight: 600 }} data-testid="takes-window-photo">
                {photo?.name ?? state.activeImage}
              </div>
              <div className="kicker" style={{ fontSize: 10, letterSpacing: ".14em" }} data-testid="takes-window-count">
                {takes.length} {takes.length === 1 ? "TAKE" : "TAKES"}
                {state.multiTakes.length > 0 ? ` · ${state.multiTakes.length} COMPARED` : ""}
              </div>
              <div style={{ flex: 1 }} />
              <button
                className="chip"
                data-testid="takes-window-new"
                data-hint="Branch a new take from the active one; name it in its row"
                onClick={() => dispatch({ type: "new_take" })}
                style={{ fontSize: 11, padding: "3px 10px", color: "var(--accent)", borderColor: "var(--accent-dim)" }}
              >
                New take
              </button>
              {state.multiTakes.length > 0 && (
                <button
                  className="chip"
                  data-testid="takes-window-clear-compare"
                  data-hint="Show the active take alone again"
                  onClick={() => dispatch({ type: "clear_multi_takes" })}
                  style={{ fontSize: 11, padding: "3px 10px" }}
                >
                  Clear compare
                </button>
              )}
            </div>
            <div style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.5 }}>
              Each take is a complete edit of this photograph. Switch to work in one, rate them against each other, and keep the reasoning in the note. Compare shows up to {MULTI_MAX} side by side in the viewer.
            </div>
            <div data-testid="takes-window-list" style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
              {takes.map((t) => {
                const isActive = t.id === activeId;
                const shown = state.multiTakes.includes(t.id);
                const compareFull = state.multiTakes.length >= MULTI_MAX && !shown;
                return (
                  <div
                    key={`${state.activeImage}:${t.id}`}
                    data-testid={`takes-window-row-${t.id}`}
                    data-active={isActive}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                      padding: "10px 12px",
                      background: isActive ? "#141f24" : "var(--panel, rgba(255,255,255,.026))",
                      border: "1px solid var(--line-2)",
                      borderLeft: isActive ? "3px solid var(--accent)" : "3px solid transparent",
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <DraftField
                        value={t.name}
                        testid={`takes-window-name-${t.id}`}
                        placeholder="Take name"
                        label="Take name"
                        onCommit={(name) => dispatch({ type: "update_take", takeId: t.id, name, note: t.note })}
                      />
                      {/* Icons for the state and the actions: the ring with a dot is the take
in force, the empty ring switches to that take.*/}
                      {isActive ? (
                        <span
                          data-testid={`takes-window-active-${t.id}`}
                          aria-label="Active take"
                          data-hint="The take in force: the viewer and the panels show this one"
                          style={{ display: "inline-flex", alignItems: "center", color: "var(--accent)", padding: "3px 4px" }}
                        >
                          <ActiveIcon on />
                        </span>
                      ) : (
                        <button
                          className="chip bare"
                          data-testid={`takes-window-switch-${t.id}`}
                          aria-label={`Switch to ${t.name}`}
                          data-hint={`Work in ${t.name}: the viewer and the panels switch to it`}
                          onClick={() => dispatch({ type: "switch_take", takeId: t.id })}
                          style={{ display: "inline-flex", alignItems: "center", padding: "3px 4px", color: "var(--text-ghost)" }}
                        >
                          <ActiveIcon on={false} />
                        </button>
                      )}
                      <TakeStars take={t} dispatch={dispatch} />
                      <button
                        className="chip bare"
                        data-testid={`takes-window-compare-${t.id}`}
                        data-active={shown}
                        aria-pressed={shown}
                        disabled={compareFull}
                        aria-label={shown ? `Stop comparing ${t.name}` : `Compare ${t.name}`}
                        data-hint={compareFull ? `${MULTI_MAX} at once is the limit` : shown ? "Take this one out of the side-by-side view" : "Show this take beside the others in the viewer"}
                        onClick={() => dispatch({ type: "toggle_multi_take", takeId: t.id })}
                        style={{ display: "inline-flex", alignItems: "center", padding: "3px 4px", color: shown ? "var(--accent)" : "var(--text-ghost)" }}
                      >
                        <CompareIcon />
                      </button>
                      {takes.length > 1 && (
                        <button
                          className="chip bare"
                          data-testid={`takes-window-delete-${t.id}`}
                          aria-label={`Delete ${t.name}`}
                          data-hint="Delete this take and the edits in it; the main window asks first"
                          onClick={() => dispatch({ type: "ask_confirm", action: { kind: "delete_take", takeId: t.id, name: t.name } })}
                          style={{ display: "inline-flex", alignItems: "center", padding: "3px 4px", color: "var(--text-ghost)" }}
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                    <DraftField
                      value={t.note ?? ""}
                      testid={`takes-window-note-${t.id}`}
                      placeholder="Notes: what this take is trying, what the client said, what to check before it ships"
                      label={`Notes for ${t.name}`}
                      multiline
                      onCommit={(note) => dispatch({ type: "update_take", takeId: t.id, name: t.name, note })}
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <PopoutStatusRow testid="takes-window-hint" />
    </div>
  );
}
