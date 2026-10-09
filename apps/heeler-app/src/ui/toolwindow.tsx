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
import { curveModeOf, toolNode } from "../state";
import { CurveEditor, Wheel } from "./editors";
import {
  DOCK_CHANNEL,
  STATE_CHANNEL,
  STATE_REQUEST,
  FRAME_CHANNEL,
  FRAME_REQUEST,
  TOOL_WINDOWS,
  applySnapshot,
  sendCommand,
  transport,
  type GraphSnapshot,
  type ToolWindowKind,
} from "../popout";
import { DockButton, MacInset, WindowControls } from "./chrome";
import { useHintSource } from "./hints";
import { PopoutStatusRow } from "./popoutstatus";
import { EqEditor } from "./eqeditor";
import { Slider } from "./simple";
import { RecolorBlock } from "./recolor";
import { GuardStrip } from "./guardstrip";
import { ColorConsoleBlock } from "./colorconsole";
import { isLayerNode } from "../layerids";

/** The live preview frame, pushed from the main window on every render
 * (the spectrums' channel; Relight's histogram reads the same one, and
 * so does the popped-out graph window's Inspector). */
export function useLiveFrame(want: boolean): string | null {
  const [frame, setFrame] = useState<string | null>(null);
  useEffect(() => {
    if (!want) return;
    const un = transport().subscribe(FRAME_CHANNEL, (payload: unknown) => {
      const f = (payload as { frame?: string | null } | null)?.frame ?? null;
      setFrame(f);
    });
    transport().send(FRAME_REQUEST, true);
    return un;
  }, [want]);
  return frame;
}

/** The section each window's tool lives in, for the switch below. */
const TOOL_SECTION: Record<ToolWindowKind, string> = {
  curves: "Curves",
  wheels: "Color Wheels",
  toneeq: "Relight",
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
  if (kind === "colorconsole") {
    // The node the panel edits: with a layer selected that is the
    // layer's own Color Tune. Finding the first console in the graph
    // popped the window out onto the MAIN chain's node while the panel
    // worked the layer's, and an edit out here landed somewhere the
    // user was not looking. Curves and Color Wheels already resolve
    // theirs through toolNode.
    const node = toolNode(snap, "colorconsole");
    if (!node || (!node.enabled && !isLayerNode(node.id)))
      return <ToolNotOn title={TOOL_SECTION[kind]} dispatch={dispatch} />;
    // The window layout is the widget's own (the wheel takes
    // the left side, the controls the right, Smoothing above the buttons).
    return (
      <ColorConsoleBlock
        node={node}
        dispatch={dispatch}
        windowed
        width={Math.max(420, stage.w - 36)}
        height={Math.max(280, stage.h - 60)}
        band={snap.consoleBand}
        onBand={(id) => dispatch({ type: "set_console_band", id })}
        pickArmed={snap.consolePick === node.id}
        pickBand={snap.consolePickBand}
        onTogglePick={(band) => dispatch({ type: "toggle_console_pick", id: node.id, band })}
        customMax={snap.prefs.consoleCustomMax}
        nameFormat={snap.prefs.consoleNameFormat}
        onNameFormat={(fmt) => dispatch({ type: "set_prefs", prefs: { consoleNameFormat: fmt } })}
      />
    );
  }
  if (kind === "recolor") {
    const node = snap.nodes.find((n) => n.type === "heeler.recolor");
    if (!node || !node.enabled)
      return <ToolNotOn title={TOOL_SECTION[kind]} dispatch={dispatch} />;
    const w = Math.max(380, stage.w - 36);
    // The reserve was sized for the old cell grid; the two menus plus
    // the sliders need far less, and the leftover read as dead space
    // above the plot (the owner's report).
    const h = Math.max(240, stage.h - 140);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: w }}>
        <RecolorBlock
          node={node}
          allNodes={snap.nodes}
          clipboard={snap.recolorClipboard}
          dispatch={dispatch}
          width={w}
          height={h}
          histogramSrc={frame ?? snap.images.find((i) => i.id === snap.activeImage)?.src}
          cell={snap.recolorCell}
          onCell={(c) => dispatch({ type: "set_recolor_cell", cell: c })}
          pickArmed={snap.recolorPick === node.id}
          hoverX={snap.recolorPick === node.id ? snap.recolorHoverX : null}
          onTogglePick={() => dispatch({ type: "toggle_recolor_pick", id: node.id })}
          matchArmed={snap.recolorMatch?.id === node.id}
          onToggleMatch={() => dispatch({ type: "toggle_recolor_match", id: node.id })}
          depthView={snap.depthView}
          depthRed={snap.maskRed}
          onToggleDepthView={(flavor) => dispatch({ type: "toggle_depth_view", flavor })}
        />
        <div>
          {snap.recolorCell.startsWith("around_") && (
            <Slider label="Around reach" param="around_radius" node={node} dispatch={dispatch} centered={false} />
          )}
          <Slider label="Neutral guard" param="neutral_guard" node={node} dispatch={dispatch} centered={false} />
          <GuardStrip state={snap} node={node} cell={snap.recolorCell} dispatch={dispatch} />
          <Slider label="Smoothing" param="smoothing" node={node} dispatch={dispatch} centered={false} />
        </div>
      </div>
    );
  }
  if (kind === "toneeq") {
    // Same layer rule as Color Tune's window: the layer's own Relight,
    // not the first tone_eq in the graph.
    const node = toolNode(snap, "toneeq");
    if (!node || (!node.enabled && !isLayerNode(node.id)))
      return <ToolNotOn title={TOOL_SECTION[kind]} dispatch={dispatch} />;
    // The whole point of the window: the same widget REDRAWN at window
    // size, points and grab radii scaled with it, never a small plot
    // stretched to a blur.
    // Widget above, the surviving dials and the picker below: the
    // same trio the panel shows, at window size.
    const w = Math.max(360, stage.w - 36);
    const h = Math.max(240, stage.h - 150);
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, width: w }}>
        <EqEditor
          node={node}
          dispatch={dispatch}
          width={w}
          height={h}
          histogramSrc={frame ?? snap.images.find((i) => i.id === snap.activeImage)?.src}
          pickArmed={snap.toneEqPick === node.id}
          hoverX={snap.toneEqPick === node.id ? snap.toneEqHoverX : null}
          onTogglePick={() => dispatch({ type: "toggle_tone_eq_pick", id: node.id })}
        />
        <div>
          <Slider label="Range shift" param="range_shift" node={node} dispatch={dispatch} />
          <Slider label="Smoothing" param="smoothing" node={node} dispatch={dispatch} centered={false} />
        </div>
      </div>
    );
  }
  if (kind === "curves") {
    const node = toolNode(snap, "curves");
    // Layer tools arm themselves on first touch; a global tool that is
    // not enabled shows the switch instead of silently coming on.
    if (!node || (!node.enabled && !isLayerNode(node.id)))
      return <ToolNotOn title={TOOL_SECTION[kind]} dispatch={dispatch} />;
    // The chip row and interp row take ~70px; the rest is plot. Redrawn
    // at this size: points, strokes and grab radii scale with it.
    const w = Math.max(320, stage.w - 36);
    const h = Math.max(220, stage.h - 106);
    return (
      <CurveEditor
        node={node}
        dispatch={dispatch}
        width={w}
        height={h}
        channelMode={curveModeOf(snap)}
        clipboard={snap.curveClipboard}
        histogramSrc={snap.images.find((i) => i.id === snap.activeImage)?.src}
        // The eyedropper samples the photograph, which lives in the
        // MAIN window's viewer; arming it from here is a command like
        // any other, and the ghost point rides back in the snapshot.
        pickArmed={snap.curvePick?.nodeId === node.id}
        hoverX={snap.curvePick?.nodeId === node.id ? snap.curveHoverX : null}
        onTogglePick={(ch) => dispatch({ type: "arm_curve_pick", nodeId: node.id, channel: ch })}
      />
    );
  }
  const node = toolNode(snap, "wheels");
  if (!node || (!node.enabled && !isLayerNode(node.id)))
    return <ToolNotOn title={TOOL_SECTION[kind]} dispatch={dispatch} />;
  const ranges: [string, string][] = [
    ["Shadows", "shadows"],
    ["Mids", "midtones"],
    ["Highs", "highlights"],
  ];
  // Fit the discs to the room: columns split the width, the readouts
  // under a disc take ~70px, and nothing may leave the stage.
  const size = Math.max(
    120,
    Math.min(Math.floor((stage.w - 40) / ranges.length) - 24, stage.h - 110),
  );
  return (
    <div style={{ display: "flex", gap: 24, justifyContent: "center" }} data-testid={`toolwindow-${kind}`}>
      {ranges.map(([label, range]) => (
        <div key={range} style={{ width: size, display: "flex" }}>
          <Wheel
            name={label}
            range={range}
            node={node}
            dispatch={dispatch}
            showLum
            size={size}
          />
        </div>
      ))}
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
