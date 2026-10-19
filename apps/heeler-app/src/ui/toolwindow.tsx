// Color Wheels, Curves and the other grading tools in windows of their own.
//
// "Just like the Color Bend, make the following
// adjustment tools able to pop out to larger floating windows. Don't
// scale the controllers as they will blur, actually render new
// controls that scale."
//
// One thin client for all three, the same shape as the Bend window: it
// owns no state and runs no engine. It renders its tool out of a
// snapshot the main window pushes, every edit is forwarded back there
// to be reduced, and the controls are REDRAWN at window size (the
// editors take real pixel sizes), never CSS-stretched.

import { useEffect, useRef, useState } from "react";
import { logDebug } from "../log";
import { initialState } from "../data";
import type { Command, State } from "../state";
import { toolNode } from "../state";
import { DOCK_CHANNEL, STATE_CHANNEL, STATE_REQUEST, TOOL_WINDOWS, applySnapshot, sendCommand, transport, type GraphSnapshot, type ToolWindowKind } from "../popout";
import { DockButton, MacInset, WindowControls } from "./chrome";
import { useHintSource } from "./hints";
import { PopoutStatusRow } from "./popoutstatus";
import { SectionFace } from "./sectionface";
import { WINDOW_FIT, sectionNamed } from "./sectionfaceparts";
import { isLayerNode } from "../layerids";
import { useLiveFrame } from "./toolwindowparts";

/** The section each window's tool lives in, for the switch below. */
const TOOL_SECTION: Record<ToolWindowKind, string> = {
  curves: "Curves",
  wheels: "Color Wheels",
  toneeq: "Tone Equalizer",
  recolor: "Recolor",
  colorconsole: "Color Tune",
};

/** The window's power screen: the tool is not enabled on this
 * photograph (its node missing or switched off, one thing from the
 * chair), and the switch here turns it on without a trip back to the
 * main window. Popping out never enables a tool by itself. The
 * report: "I want the '... has not been used on this photograph yet.'
 * message with the option to turn it on."*/
export function ToolNotOn({
  title,
  dispatch,
}: {
  title: string;
  dispatch: (c: Command) => void;
}) {
  return (
    <div
      data-testid="tool-window-off"
      style={{ display: "grid", gap: 14, justifyItems: "center", fontSize: 11, color: "var(--text-body)" }}
    >
      <div>{title} has not been used on this photograph yet.</div>
      <button
        className="chip"
        data-testid="tool-window-power"
        style={{ fontSize: 10, padding: "3px 12px" }}
        // The section unfolds in the panel only if the preference says
        // so; the reducer reads it, so the window need not.
        onClick={() => dispatch({ type: "set_category", title, on: true })}
      >
        SWITCH IT ON
      </button>
    </div>
  );
}

/** What each window renders once it has a snapshot and its node. */
function ToolBody({
  kind,
  snap,
  stage,
}: {
  kind: ToolWindowKind;
  snap: State;
  stage: { w: number; h: number };
}) {
  const dispatch = (cmd: Command) => sendCommand(cmd);
  const frame = useLiveFrame(kind === "toneeq" || kind === "recolor");
  // Each window's node: with a layer selected that is the layer's own
  // tool. Finding the first of its type in the graph popped a window out
  // onto the MAIN chain's node while the panel worked the layer's, and an
  // edit out here landed somewhere the user was not looking.
  const node = kind === "recolor" ? snap.nodes.find((n) => n.type === "heeler.recolor") : toolNode(snap, kind);
  // Layer tools arm themselves on first touch; a global tool that is not
  // enabled shows the switch instead of silently coming on.
  if (!node || (!node.enabled && (kind === "recolor" || !isLayerNode(node.id))))
    return <ToolNotOn title={TOOL_SECTION[kind]} dispatch={dispatch} />;
  const sec = sectionNamed(TOOL_SECTION[kind])!;
  // The panel's face at window size, from the same definition
  // (sectionface.tsx): the section's rows and widgets in Develop's order,
  // the widgets REDRAWN at window size (points, strokes and grab radii
  // scale with them), never a small plot stretched to a blur.
  const fit = WINDOW_FIT[kind];
  const w = Math.max(fit.minW, stage.w - 36);
  const h = Math.max(fit.minH, stage.h - fit.reserve);
  // The wheels fit to the room: columns split the width, the readouts
  // and the help line under a disc take the reserve, and nothing may
  // leave the stage.
  const disc = kind === "wheels" ? Math.max(120, Math.min(Math.floor((stage.w - 40) / 3) - 24, stage.h - fit.reserve)) : undefined;
  return (
    <div style={{ width: kind === "wheels" ? undefined : w }} data-testid={`toolwindow-${kind}`}>
      <SectionFace
        sec={sec}
        node={node}
        dispatch={dispatch}
        state={snap}
        width={w}
        graphHeight={h}
        discSize={disc}
        frame={frame ?? snap.images.find((i) => i.id === snap.activeImage)?.src}
        windowed={kind === "colorconsole"}
      />
    </div>
  );
}

export function ToolWindow({ kind }: { kind: ToolWindowKind }) {
  useHintSource();
  const [snap, setSnap] = useState<State | null>(null);
  const [stage, setStage] = useState({ w: 600, h: 400 });
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(
    () =>
      transport().subscribe(STATE_CHANNEL, (payload: unknown) =>
        setSnap(applySnapshot(initialState(), payload as GraphSnapshot)),
      ),
    [],
  );

  // Ask for state until it lands: the main window may still be booting,
  // and a request nobody heard is a window that waits forever.
  useEffect(() => {
    if (snap) return;
    transport().send(STATE_REQUEST, true);
    const timer = setInterval(() => transport().send(STATE_REQUEST, true), 400);
    return () => clearInterval(timer);
  }, [snap]);

  // Breadcrumbs into the shared console: these lines ride the same
  // transport the snapshot does, so which of them shows up says which
  // leg of the handshake is broken when a window sits there waiting.
  useEffect(() => {
    logDebug(() => `${kind} window: open, asking the main window for state`);
  }, [kind]);
  const gotFirst = useRef(false);
  useEffect(() => {
    if (snap && !gotFirst.current) {
      gotFirst.current = true;
      logDebug(() => `${kind} window: state received`);
    }
  }, [snap, kind]);

  // The stage's real size drives the controls' drawn size.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setStage((prev) =>
        Math.abs(prev.w - next.w) > 6 || Math.abs(prev.h - next.h) > 6 ? next : prev,
      );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="app" data-testid={`tool-window-${kind}`}>
      <div
        className="titlebar"
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 0 0 12px",
        }}
      >
        <MacInset />
        <div className="kicker" style={{ letterSpacing: ".16em" }} data-tauri-drag-region>
          {TOOL_WINDOWS[kind].title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DockButton testid="tool-window-dock" hint="Put this tool back in the panel" onClick={() => transport().send(DOCK_CHANNEL, kind)} />
          <WindowControls />
        </div>
      </div>
      <div
        ref={box}
        data-testid="tool-window-stage"
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 18,
          overflow: "hidden",
        }}
      >
        {snap ? (
          <ToolBody kind={kind} snap={snap} stage={stage} />
        ) : (
          <div
            data-testid="tool-window-waiting"
            style={{ fontSize: 10, color: "var(--text-ghost)" }}
          >
            Waiting for the main window.
          </div>
        )}
      </div>
      <PopoutStatusRow testid="tool-window-hint" />
    </div>
  );
}
