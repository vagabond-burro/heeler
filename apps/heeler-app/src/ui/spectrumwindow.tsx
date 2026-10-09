// The spectrums in a window of their own.
//
// A thin client, the same shape as the popped-out graph: it renders no
// photograph and runs no engine, it just receives the frame the main
// window is already showing and plots it. Bigger, so a waveform is worth
// looking at closely, and draggable outside the app for a second
// monitor.

import { useEffect, useState } from "react";
import { initialState } from "../data";
import type { Command, State } from "../state";
import { Spectrums } from "./spectrum";
import {
  DOCK_CHANNEL,
  FRAME_CHANNEL,
  SPECTRUM_LABEL,
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

export function SpectrumWindow() {
  useHintSource();
  const [frame, setFrame] = useState<string | null>(null);
  const [approx, setApprox] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [snap, setSnap] = useState<State | null>(null);

  useEffect(
    () =>
      transport().subscribe(FRAME_CHANNEL, (payload: unknown) => {
        const p = payload as { frame?: string | null; engine?: boolean };
        setFrame(p?.frame ?? null);
        // The main window sends the photograph's thumbnail when the
        // engine's own frame is not ready, which is what stops this
        // window sitting empty beside a panel that is plotting.
        setApprox(p?.frame != null && p.engine === false);
        // The frame can be the same URL with different pixels behind it,
        // so the plot is nudged rather than left to a string comparison.
        setNonce((n) => n + 1);
      }),
    [],
  );

  // The Harmony row edits real session state (mode, strength, and the
  // anchor by dragging on the wheel), so this window rides the same
  // snapshot transport as every other pop-out rather than plotting a
  // throwaway initialState: the main window owns the reducer, the
  // snapshot comes down on STATE_CHANNEL, and every control's command
  // goes back over CMD_CHANNEL to be reduced there.
  useEffect(
    () =>
      transport().subscribe(STATE_CHANNEL, (payload: unknown) =>
        setSnap(applySnapshot(initialState(), payload as GraphSnapshot)),
      ),
    [],
  );

  // Ask for one. The main window pushes on every new frame, but a
  // photograph nobody is editing produces no new frames, so without
  // asking this would wait correctly and forever. Repeated until
  // something arrives, because the listener on the other side may not be
  // up yet when a freshly opened window first asks.
  useEffect(() => {
    if (frame) return;
    transport().send(FRAME_REQUEST, true);
    const timer = setInterval(
      () => transport().send(FRAME_REQUEST, true),
      700,
    );
    return () => clearInterval(timer);
  }, [frame]);

  // Same ask for the snapshot, on the cadence the tool windows use.
  useEffect(() => {
    if (snap) return;
    transport().send(STATE_REQUEST, true);
    const timer = setInterval(() => transport().send(STATE_REQUEST, true), 400);
    return () => clearInterval(timer);
  }, [snap]);

  return (
    <div className="app" data-testid="spectrum-window">
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
        <div
          className="kicker"
          style={{ letterSpacing: ".16em" }}
          data-tauri-drag-region
        >
          Heeler Spectrums
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <DockButton testid="spectrums-dock" hint="Put the spectrums back in the panel" onClick={() => transport().send(DOCK_CHANNEL, SPECTRUM_LABEL)} />
          <WindowControls />
        </div>
      </div>
      {/* Fills the window rather than sitting at a fixed height, which
          is what left a band of nothing along the bottom. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Spectrums
          state={{ ...(snap ?? initialState()), previewNonce: nonce }}
          // No dispatch until the snapshot has landed: the Harmony row
          // renders only when there is a dispatch to act through, and a
          // control over throwaway state would write to nobody.
          dispatch={snap ? (cmd: Command) => sendCommand(cmd) : undefined}
          frame={frame}
          approx={approx}
          sample={1600}
          fill
        />
      </div>
      <PopoutStatusRow testid="spectrum-window-hint" />
    </div>
  );
}
