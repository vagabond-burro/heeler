// The color wheel in a window of its own.
//
// "I love this color tool. It can be tricky to do finer
// edits. I think what would be nice is a button that pops this out into
// a larger floating window I can drag around. Like 2x larger."
//
// A thin client, the same shape as the popped-out graph: it owns no
// state and runs no engine. It renders the node out of a snapshot the
// main window pushes, and every edit it makes is forwarded back there to
// be reduced. Two reducers running the same commands would drift the
// moment one missed a message, and a color wheel that disagrees with
// the panel about what the current hue is would be worse than no wheel.

import { useEffect, useRef, useState } from "react";
import { initialState } from "../data";
import type { Command, State } from "../state";
import { BendWheel } from "./bend";
import {
  BEND_LABEL,
  DOCK_CHANNEL,
  FRAME_CHANNEL,
  FRAME_REQUEST,
  STATE_CHANNEL,
  STATE_REQUEST,
  applySnapshot,
  sendCommand,
  transport,
  type GraphSnapshot,
} from "../popout";
import { DockButton, MacInset, WindowControls } from "./chrome";
import { useHintSource } from "./hints";
import { PopoutStatusRow } from "./popoutstatus";
import { ToolNotOn } from "./toolwindow";
import { isLayerNode } from "../layerids";

/** The disc size that fits a stage of `w` by `h` with `chrome` pixels of
 * controls above it.
 *
 * Pulled out because it is the whole of the bug the owner hit. "The
 * controls are overlapping": the old version handed the wheel the full
 * height of the box and the row of chips above the disc had to go
 * somewhere, so a flex child centered in a box it did not fit in
 * overflowed in both directions and the top of it went through the title
 * bar.
 */
export function fitWheel(w: number, h: number, chrome: number): number {
  // A floor rather than a shrink to nothing: below this the handles are
  // too small to grab, and a window that small is not being used to bend
  // anything.
  return Math.max(180, Math.round(Math.min(w, h - chrome)));
}

export function BendWindow() {
  useHintSource();
  const [snap, setSnap] = useState<State | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  // The wheel fills the window, which is the entire reason the window
  // exists: a bigger target for a fine edit.
  const [wheel, setWheel] = useState(420);
  const box = useRef<HTMLDivElement | null>(null);
  const card = useRef<HTMLDivElement | null>(null);

  // Fit the wheel to the room there actually is.
  //
  // "The controls are overlapping." They were, and the cause
  // was measuring the wrong box. The wheel was sized from the element that
  // CONTAINS it, which grows when the wheel grows: a loop that settles
  // wherever it likes, usually a little too tall. A flex child centered in
  // a box it does not fit in overflows in both directions, so the extra
  // height went straight up through the title bar and the wheel's own
  // controls landed on top of it.
  //
  // Measured here instead: the outer box is flex:1 of the window and its
  // height is the window's, whatever the wheel does, and the chrome (the
  // row of chips above the disc) is whatever the card is taller than the
  // disc. Neither number can chase the other.
  const node = snap?.nodes.find((n) => n.type === "heeler.color_bend");
  const ready = !!(snap && node);

  useEffect(() => {
    const el = box.current;
    if (!el || !ready || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const chrome = card.current ? Math.max(0, card.current.offsetHeight - wheel) : 0;
      const next = fitWheel(el.clientWidth, el.clientHeight, chrome);
      // A few pixels of slack: repainting the disc is a per-pixel loop
      // over a million of them, and chasing every pixel of a window drag
      // would redraw it all the way across the screen.
      if (Math.abs(next - wheel) > 6) setWheel(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [wheel, ready]);

  useEffect(
    () =>
      transport().subscribe(STATE_CHANNEL, (payload: unknown) =>
        setSnap(applySnapshot(initialState(), payload as GraphSnapshot)),
      ),
    [],
  );

  useEffect(
    () =>
      transport().subscribe(FRAME_CHANNEL, (payload: unknown) => {
        const p = payload as { frame?: string | null };
        setFrame(p?.frame ?? null);
      }),
    [],
  );

  // Ask for a frame until one arrives. A photograph nobody is editing
  // produces no new frames, so without asking this would wait correctly
  // and forever.
  useEffect(() => {
    if (frame) return;
    transport().send(FRAME_REQUEST, true);
    const timer = setInterval(() => transport().send(FRAME_REQUEST, true), 700);
    return () => clearInterval(timer);
  }, [frame]);

  // And the same for the state, which is what "Waiting for the main
  // window" was actually waiting for. Asked for the moment the listener
  // above is live, and asked again until it lands: the main window may
  // still be starting up itself, and a request nobody heard is a window
  // that waits forever.
  useEffect(() => {
    if (snap) return;
    transport().send(STATE_REQUEST, true);
    const timer = setInterval(() => transport().send(STATE_REQUEST, true), 400);
    return () => clearInterval(timer);
  }, [snap]);

  const dispatch = (cmd: Command) => sendCommand(cmd);

  return (
    <div className="app" data-testid="bend-window">
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
          Heeler Color Bend
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DockButton testid="bend-dock" hint="Put the color wheel back in the panel" onClick={() => transport().send(DOCK_CHANNEL, BEND_LABEL)} />
          <WindowControls />
        </div>
      </div>

      <div
        ref={box}
        data-testid="bend-window-stage"
        style={{
          flex: 1,
          // A flex child reports zero height without this, and a stage of
          // no height is a wheel of no size.
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 18,
          // Belt and braces: whatever the measuring settles on, nothing
          // in here is allowed to climb out over the title bar again.
          overflow: "hidden",
        }}
      >
        {!snap ? (
          <div
            data-testid="bend-window-waiting"
            style={{ fontSize: 10, color: "var(--text-ghost)" }}
          >
            Waiting for the main window.
          </div>
        ) : ready && node && (node.enabled || isLayerNode(node.id)) ? (
          <div ref={card}>
            <BendWheel node={node} dispatch={dispatch} frame={frame} engine size={wheel} />
          </div>
        ) : (
          // Not enabled on this photograph: the same screen and switch
          // the other tool windows show, never a silent enable.
          <ToolNotOn title="Color Bend" dispatch={dispatch} />
        )}
      </div>
      <PopoutStatusRow testid="bend-window-hint" />
    </div>
  );
}
