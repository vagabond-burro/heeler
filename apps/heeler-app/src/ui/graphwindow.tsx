// The popped-out graph window.
//
// It owns no state. It renders whatever snapshot the main window last
// sent and forwards every command straight back, so the two windows can
// never disagree about what the graph is. Until the first snapshot
// arrives it shows nothing but its own chrome.
//
// Its header is the main window's header: same frameless treatment, same
// app mark, same minimize/maximize/close, same drag region. A second
// window that looks like an OS dialog next to the app reads as somebody
// else's software.

import { useEffect, useState } from "react";
import type { Command, State } from "../state";
import { initialState } from "../data";
import { NodeEditor, Inspector, InspectorBar, GroupDialog } from "./graph";
import { AppIcon, DockButton, MacInset, WindowControls } from "./chrome";
import { DOCK_CHANNEL, GRAPH_KEY_CHANNEL, STATE_CHANNEL, STATE_REQUEST, applySnapshot, sendCommand, transport, type GraphSnapshot } from "../popout";
import { useLiveFrame } from "./toolwindow";
import { isTauri } from "../bridge";
import { setHintOverrides, useHintSource } from "./hints";
import { PopoutStatusRow } from "./popoutstatus";
import { bindingMap, bindingOf, keyBelongsToFocus, popoutGraphCommand } from "../hotkeys";

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function GraphWindow() {
  const [snap, setSnap] = useState<GraphSnapshot | null>(null);
  useHintSource();
  // This window's hints print live bindings too; the snapshot carries
  // the same prefs the main window's state does.
  useEffect(() => {
    if (snap?.prefs?.hotkeys) setHintOverrides(snap.prefs.hotkeys);
  }, [snap?.prefs?.hotkeys]);

  useEffect(() => transport().subscribe(STATE_CHANNEL, (p: GraphSnapshot) => setSnap(p)), []);
  // The frame the main window is showing, for the Inspector's spectrums
  // and the widgets' histogram underlays: this window renders no
  // photograph of its own, but the plots mean the same thing here as in
  // Develop when they read the same frame (2026-09-08: "the pop out
  // graph view's inspector does not show the histogram").
  const frame = useLiveFrame(true);

  // Ask for a snapshot on open: the main window has no idea we exist
  // until we say so, and without this the pane stays empty until the
  // next edit happens to push one.
  //
  // This used to dispatch set_graph_popped_out to force a state change
  // and ride the push that followed. Asking outright says what it means,
  // and keeps asking until an answer arrives, since the main window may
  // still be starting up when the first one goes out.
  useEffect(() => {
    if (snap) return;
    transport().send(STATE_REQUEST, true);
    const timer = setInterval(() => transport().send(STATE_REQUEST, true), 400);
    return () => clearInterval(timer);
  }, [snap]);

  // The graph's keys, here as in the docked graph: Cmd+D duplicates,
  // Delete deletes, F frames (2026-10-01: "We need a hotkey to
  // duplicate selected nodes"). This window holds no state, so a key
  // is resolved to a command id and the main window runs it; framing
  // alone is measured here, since only this window has the editor.
  const hotkeys = snap?.prefs?.hotkeys;
  useEffect(() => {
    if (!snap) return;
    const onKey = (e: KeyboardEvent) => {
      if (keyBelongsToFocus(e)) return;
      const id = (bindingMap(hotkeys ?? {}).get(bindingOf(e)) ?? []).find(popoutGraphCommand);
      if (!id) return;
      e.preventDefault();
      if (id === "graph.frame") {
        const el = document.querySelector('[data-testid="graph-window"] [data-testid="node-editor"]');
        if (!el) return;
        const r = el.getBoundingClientRect();
        sendCommand({ type: "frame_graph", w: r.width, h: r.height });
        return;
      }
      transport().send(GRAPH_KEY_CHANNEL, id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [!!snap, hotkeys]);

  const dispatch = (cmd: Command) => sendCommand(cmd);
  const state: State | null = snap ? applySnapshot(initialState(), snap) : null;

  const dock = () => {
    transport().send(DOCK_CHANNEL, true);
    if (isTauri()) void currentWindow().then((w) => w.close());
    else window.close();
  };

  return (
    <div
      data-testid="graph-window"
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-app)", color: "var(--text-body)" }}
    >
      <div className="topbar" data-testid="graph-window-bar" data-tauri-drag-region>
        <MacInset />
        <div className="brand" data-tauri-drag-region>
          <AppIcon />
          <span data-tauri-drag-region>HEELER</span>
        </div>
        <div className="vsep" />
        <div className="mode-label" data-tauri-drag-region>Graph</div>
        <div className="center" data-tauri-drag-region>
          <span className="file tnum" data-tauri-drag-region>
            {state ? (state.images.find((i) => i.id === state.activeImage)?.name ?? state.activeImage) : ""}
          </span>
        </div>
        {/* marginLeft auto: .center is absolute against the bar now
            (true-centered), so the right cluster pushes itself over. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
          <DockButton testid="graph-window-dock" hint="Put the graph back in the main window" onClick={dock} />
          <WindowControls />
        </div>
      </div>
      {state ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <NodeEditor state={state} dispatch={dispatch} />
          </div>
          {state.inspectorHome === "graph" ? (
            <Inspector state={state} dispatch={dispatch} width={state.panelSizes.right} frame={frame} pickers={false} />
          ) : (
            <InspectorBar onClick={() => dispatch({ type: "set_inspector_home", home: "graph" })} />
          )}
          <GroupDialog state={state} dispatch={dispatch} />
        </div>
      ) : (
        <div
          data-testid="graph-window-waiting"
          style={{ flex: 1, display: "grid", placeItems: "center", fontSize: 11, color: "var(--text-ghost)", letterSpacing: ".08em" }}
        >
          WAITING FOR THE MAIN WINDOW
        </div>
      )}
      {/* This window has no viewer, so it carries its own status row for
          the same help text. */}
      <PopoutStatusRow testid="graph-window-status" />
    </div>
  );
}
