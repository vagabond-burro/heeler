// The Tether tab: a shoot straight into Heeler. The SESSION half
// watches the folder a camera or vendor tether app writes into. The
// CAMERA half is direct capture: phase 1 sees the body on USB, fires
// the shutter, and lands the frame through the session's own import
// path; phase 2 adds exposure control, every control offering only
// what the connected body's descriptor lists. Live view is a later
// phase and gets no dead controls here.

import React, { useEffect, useRef, useState } from "react";
import {
  entryFromRow,
  isTauri,
  listCollections,
  loadThumbnail,
  pickExportFolder,
  tetherPoll,
  tetherStart,
  tetherStop,
  usbCameraCapture,
  usbCameraAutofocus,
  usbCameraConnect,
  usbCameraDisconnect,
  usbCameraExposure,
  usbCameraFocusDrive,
  usbCameraLiveviewFrame,
  usbCameraLiveviewStart,
  usbCameraLiveviewStop,
  usbCameraPoll,
  usbCameraScan,
  usbCameraSetExposure,
  usbCameraStatus,
  type CameraScan,
  type CameraState,
  type ExposureState,
  type TetherImage,
} from "../bridge";
import { logMsg } from "../log";
import { clampTetherPoll, type Command, type State } from "../state";
import { MenuField } from "./menufield";

type D = React.Dispatch<Command>;

/** One row of the tab: label left, control filling the rest. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="srow" style={{ gridTemplateColumns: "64px 1fr" }}>
      <div className="lbl">{label}</div>
      {children}
    </div>
  );
}

// The focus row's glyphs. Drawn here rather than fetched, the way the
// panel tabs are: five buttons' worth of lines is not worth an icon
// font's network request and flash of nothing. 16 by 16 on a 1.6
// stroke, matching the chrome around them.
const glyph = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  // Decorative: the button carries the accessible name, and a second
  // reading here would have a screen reader say it twice.
  "aria-hidden": true,
  focusable: false,
};

/** A chevron pointing the way the focus travels; two of them for the big step. */
function FocusChevrons({ dir, big }: { dir: "near" | "far"; big: boolean }) {
  return (
    <svg {...glyph} style={{ transform: dir === "far" ? "scaleX(-1)" : "none" }}>
      <path d={big ? "M11.5 3.5 7 8l4.5 4.5" : "M9.75 3.5 5.25 8l4.5 4.5"} />
      {big && <path d="M7 3.5 2.5 8 7 12.5" />}
    </svg>
  );
}

/** The viewfinder brackets closing on a point: autofocus, as every body prints it. */
function AutofocusIcon() {
  return (
    <svg {...glyph}>
      <path d="M2.5 5.75v-2.5a.75.75 0 0 1 .75-.75h2.5" />
      <path d="M10.25 2.5h2.5a.75.75 0 0 1 .75.75v2.5" />
      <path d="M13.5 10.25v2.5a.75.75 0 0 1-.75.75h-2.5" />
      <path d="M5.75 13.5h-2.5a.75.75 0 0 1-.75-.75v-2.5" />
      <circle cx="8" cy="8" r="2.1" />
    </svg>
  );
}

// Exposure value formatting, per the encodings proven by the DC-S5
// descriptor dump on 2026-08-26. Anything outside the known encodings
// stays hex: a control that shows raw hex is honest, one that guesses
// is not.
const fmtExposure = (key: string, v: number): string => {
  switch (key) {
    case "iso":
      // 0xFFFFFFFF is the body's auto entry; the rest are plain ISO.
      return v === 0xffffffff ? "Auto" : String(v);
    case "shutter": {
      if (v === 0xffffffff) return "Bulb";
      // Bit 31 marks whole seconds (value/1000); otherwise the value
      // is 1/(value/1000) of a second.
      if (v & 0x80000000) return `${(v & 0x7fffffff) / 1000} s`;
      const d = v / 1000;
      return `1/${Number.isInteger(d) ? d : d.toFixed(1)}`;
    }
    case "aperture":
      // F-number times ten: the dump's current 80 with the lens at
      // f/8.0, range 220..28 as f/22..f/2.8.
      return `f/${(v / 10).toFixed(1)}`;
    case "white_balance":
      return WB_NAMES[v] ?? (v >= 0x800b && v <= 0x8015 ? `Preset ${v - 0x800a}` : `0x${v.toString(16)}`);
    default:
      return `0x${v.toString(16)}`;
  }
};

// The named white balance entries, per libgphoto2's Panasonic table
// and confirmed against the DC-S5's own list (0x800B up are presets).
const WB_NAMES: Record<number, string> = {
  2: "Auto",
  4: "Daylight",
  5: "Fluorescent",
  6: "Tungsten",
  7: "Flash",
  0x8008: "Cloudy",
  0x8009: "White set",
  0x800a: "Black white",
};

/** A labeled collapsible: the label stays put, the body folds away so
 * the panel's working controls keep the room. Body text is label-sized
 * (11px): help nobody can read is not help. */
function Fold({
  label,
  testid,
  children,
}: {
  label: string;
  testid: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={testid} style={{ border: "1px solid var(--line-2)", borderRadius: 2 }}>
      <button
        className="chip"
        data-testid={`${testid}-toggle`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 11, padding: "3px 8px", width: "100%", textAlign: "left", letterSpacing: ".04em" }}
      >
        {open ? "▾" : "▸"} {label}
      </button>
      {open && (
        <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.55, padding: "2px 9px 7px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

function FolderLine({
  value,
  placeholder,
  onPick,
  onClear,
  testid,
}: {
  value: string | null;
  placeholder: string;
  onPick: () => void;
  onClear?: () => void;
  testid: string;
}) {
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", minWidth: 0 }}>
      <button
        className="chip"
        data-testid={testid}
        style={{ fontSize: 10, padding: "1px 7px", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}
        onClick={onPick}
      >
        {value ? value.split(/[\\/]/).pop() : placeholder}
      </button>
      {value && onClear && (
        <button className="chip" data-testid={`${testid}-clear`} style={{ fontSize: 10, padding: "1px 5px" }} onClick={onClear}>
          ✕
        </button>
      )}
    </div>
  );
}

const VERDICT_BADGE: Record<string, string> = {
  PtpCapable: "PTP",
  MassStorageOnly: "card reader",
  KnownCameraNoImaging: "check USB mode",
};

const sameFolder = (a: string, b: string) =>
  a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/** Which arrivals belong in the list on screen. A folder view takes the
 * ones that landed in that folder; a collection view takes the ones the
 * session is adding to that collection. Everything else still moves the
 * session count and the status line, but it must not appear in a list
 * it does not belong to (and vanish on the next folder open, which was
 * the bug). */
export function arrivalsForRibbon(
  images: TetherImage[],
  state: State,
  collection: number | null,
): TetherImage[] {
  if (state.activeCollection !== null) {
    return collection !== null && collection === state.activeCollection ? images : [];
  }
  const shown = state.activeFolderPath;
  if (!shown) return [];
  return images.filter((f) => sameFolder(f.folder, shown));
}

export function TetherTab({ state, dispatch }: { state: State; dispatch: D }) {
  const [hot, setHot] = useState<string | null>(null);
  const [dest, setDest] = useState<string | null>(() => state.prefs.tetherDestination || null);
  const [pattern, setPattern] = useState(() => state.prefs.tetherNamingPattern ?? "");
  // The dial opens on the collection selected in the sidebar: picking a
  // collection there and then shooting should put frames in it without
  // a second choice here. "None" stays one click away.
  const [collection, setCollection] = useState<number | null>(() => state.activeCollection ?? null);
  const [running, setRunning] = useState(false);
  const [count, setCount] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const [advance, setAdvance] = useState(() => state.prefs.tetherAutoAdvance ?? true);
  const [scan, setScan] = useState<CameraScan | null>(null);
  const [cam, setCam] = useState<CameraState | null>(null);
  const [exposure, setExposure] = useState<ExposureState | null>(null);
  const [exposureBusy, setExposureBusy] = useState(false);
  const [busy, setBusy] = useState<"scan" | "connect" | "capture" | null>(null);
  // AF before capture (phase 4): one sweep before the shutter fires.
  // Off by default; a body already in AF focuses on the release anyway.
  const [afOnCapture, setAfOnCapture] = useState(false);
  // In-flight camera operations, synchronous so a double click in the
  // same render still sees the guard.
  const camBusy = useRef(false);
  // Live view (phase 3): the toggle, the latest frame, and the measured
  // rate. The rate is measured, never promised: USB2 bodies land in
  // single digits and that is the transport, not a bug.
  const [liveOn, setLiveOn] = useState(false);
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [liveFps, setLiveFps] = useState<number | null>(null);
  const liveOnRef = useRef(false);
  liveOnRef.current = liveOn;
  // Set while a capture is in flight: the pump holds its frame requests
  // so the body answers one thing at a time. A frame request in flight
  // when 0x9404 fires can wedge capture, holding CAPTURE down for the full
  // 30 s capture timeout.
  const livePause = useRef(false);
  // The poll reads these without re-arming the interval per keystroke.
  const dials = useRef({ dest, pattern, collection, advance });
  dials.current = { dest, pattern, collection, advance };

  /** Arrivals land in the ribbon the same way whether the folder watch
   * or the camera fetched them. The ribbon shows one folder (or
   * collection) at a time, though, so only the arrivals that belong to
   * what is on screen append; the rest still move the session count. */
  const absorb = (images: TetherImage[], sessionCount: number) => {
    setCount(sessionCount);
    if (images.length === 0) return;
    setLast(images[images.length - 1].name);
    // Membership moved: the sidebar's collection counts should move
    // with it, or the dial looks like it did nothing.
    if (dials.current.collection !== null) {
      void listCollections()
        .then((cs) => dispatch({ type: "set_collections", collections: cs }))
        .catch(() => null);
    }
    const visible = arrivalsForRibbon(images, state, dials.current.collection);
    if (visible.length === 0) return;
    const entries = visible.map((f) => entryFromRow(f));
    dispatch({ type: "append_images", images: entries });
    for (const f of visible) {
      void loadThumbnail(f.id, state.prefs.thumbnailEdge)
        .then((thumb) => {
          if (thumb) dispatch({ type: "set_thumb", id: f.id, src: thumb });
        })
        .catch(() => null);
    }
    if (dials.current.advance) {
      dispatch({ type: "select_image", id: visible[visible.length - 1].id });
    }
  };

  useEffect(() => {
    if (!running) return;
    let live = true;
    const tick = async () => {
      if (!live) return;
      try {
        const d = dials.current;
        const got = await tetherPoll({ dest: d.dest, pattern: d.pattern, collection: d.collection });
        if (!live) return;
        if (got.images.length === 0) {
          setCount((c) => Math.max(c, got.session_count));
          return;
        }
        absorb(got.images, got.session_count);
      } catch (err) {
        logMsg("error", `Tether poll: ${String(err)}`);
      }
    };
    const timer = window.setInterval(
      () => void tick(),
      clampTetherPoll(state.prefs.tetherPollMs),
    );
    void tick();
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, state.prefs.tetherPollMs, state.prefs.thumbnailEdge]);

  // The camera section opens with the truth: a scan on mount, and the
  // session's answer about a body that was connected before the tab
  // switched away.
  useEffect(() => {
    let live = true;
    void usbCameraScan().then((s) => {
      if (live) setScan(s);
    });
    void usbCameraStatus().then((s) => {
      if (live) setCam(s);
    });
    return () => {
      live = false;
    };
  }, []);

  // While a body is connected, watch its card: a shot fired on the
  // camera itself lands here. Bodies like the DC-S5 in plain PTP mode
  // announce no ObjectAdded event, so this handle-diff poll is the
  // whole arrival story for them. No landing folder, no watch: a frame
  // pulled with nowhere to go would be dropped, so the poll starts
  // when the destination does.
  const captureDest = dest || hot;
  const connected = (cam?.connected ?? false) && captureDest !== null && captureDest !== "";
  useEffect(() => {
    if (!connected) return;
    let live = true;
    const tick = async () => {
      if (!live) return;
      try {
        const d = dials.current;
        const got = await usbCameraPoll({ dest: d.dest, pattern: d.pattern, collection: d.collection });
        if (!live) return;
        absorb(got.images, got.session_count);
      } catch (err) {
        // A camera that stops answering (sleep, cable, power) is not a
        // red toast every interval: say it once and drop the session.
        logMsg("warn", `Camera watch stopped: ${String(err)}`);
        if (live) setCam(null);
        void usbCameraDisconnect().catch(() => undefined);
      }
    };
    const timer = window.setInterval(() => void tick(), clampTetherPoll(state.prefs.tetherPollMs));
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, state.prefs.tetherPollMs, state.prefs.thumbnailEdge]);

  const start = async () => {
    if (!hot) return;
    try {
      await tetherStart(hot);
      setCount(0);
      setLast(null);
      setRunning(true);
    } catch (err) {
      logMsg("error", String(err));
    }
  };
  const stop = async () => {
    setRunning(false);
    await tetherStop().catch(() => undefined);
  };

  const refresh = async () => {
    setBusy("scan");
    try {
      setScan(await usbCameraScan());
    } catch (err) {
      logMsg("error", String(err));
    } finally {
      setBusy(null);
    }
  };

  const connect = async (key: string) => {
    // setBusy reaches the disabled prop one render late; the ref is
    // what stops a double click from opening the body twice (the log
    // showed exactly that pair of Openings on the first try).
    if (camBusy.current) return;
    camBusy.current = true;
    setBusy("connect");
    try {
      setCam(await usbCameraConnect(key));
    } catch (err) {
      logMsg("error", String(err));
    } finally {
      camBusy.current = false;
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (liveOnRef.current) await liveStop();
    await usbCameraDisconnect().catch((err) => logMsg("error", String(err)));
    setCam(null);
    setExposure(null);
    void refresh();
  };

  /** Toggle off: stop the pump, tell the body, clear the frame. */
  const liveStop = async () => {
    setLiveOn(false);
    await usbCameraLiveviewStop().catch((err) => logMsg("warn", String(err)));
    setLiveFrame(null);
    setLiveFps(null);
  };

  const liveToggle = async () => {
    if (liveOn) {
      await liveStop();
      return;
    }
    try {
      await usbCameraLiveviewStart();
      setLiveOn(true);
    } catch (err) {
      logMsg("error", String(err));
    }
  };

  /** One focus step; the modes are the body's own table (see the focus
   * row). Errors surface in the log; a refused drive moves nothing. */
  const focusDrive = async (mode: number) => {
    try {
      await usbCameraFocusDrive(mode);
    } catch (err) {
      logMsg("error", `Focus drive: ${String(err)}`);
    }
  };

  /** One AF sweep (verified on the DC-S5: 0x9405 with the one-shot
   * code, lens moved, body answered 0xC104). Same stream context as
   * the drive buttons; a refusal means the body is in MF. */
  const autofocus = async () => {
    try {
      await usbCameraAutofocus();
    } catch (err) {
      logMsg("error", `Autofocus: ${String(err)}`);
    }
  };

  // The frame pump: a timeout chain, not an interval, so a slow frame
  // never stacks calls on the session lock. A body mid-work answers
  // "busy" (null) and gets asked again after a beat. A pump that keeps
  // failing would lie by freezing, so repeated errors stop it and say
  // why; the body always gets the stop parameter.
  useEffect(() => {
    if (!liveOn) return;
    let live = true;
    let errors = 0;
    let frames = 0;
    let windowStart = performance.now();
    const tick = async () => {
      if (!live) return;
      // A capture in flight gets the body to itself for the moment.
      if (livePause.current) {
        window.setTimeout(() => void tick(), 40);
        return;
      }
      let wait = 40;
      try {
        const frame = await usbCameraLiveviewFrame();
        if (!live) return;
        errors = 0;
        if (frame !== null) {
          setLiveFrame(frame);
          frames += 1;
          wait = 0;
          const span = performance.now() - windowStart;
          if (span >= 1000) {
            setLiveFps((frames * 1000) / span);
            frames = 0;
            windowStart = performance.now();
          }
        }
      } catch (err) {
        errors += 1;
        if (errors >= 3) {
          logMsg("error", `Live view stopped after repeated frame errors (${String(err)})`);
          setLiveOn(false);
          void usbCameraLiveviewStop().catch(() => null);
          return;
        }
      }
      if (live) window.setTimeout(() => void tick(), wait);
    };
    void tick();
    return () => {
      live = false;
    };
  }, [liveOn]);

  // Leaving the tab (the gate closing, a tab switch, the app going
  // away) with the stream running must still stop it on the body.
  useEffect(() => {
    return () => {
      if (liveOnRef.current) void usbCameraLiveviewStop().catch(() => null);
    };
  }, []);

  // The exposure group reads what the body offers when the session
  // comes up; a body with no vendor channel answers an empty group
  // and the section stays silent rather than rendering dead controls.
  const camConnected = cam?.connected ?? false;
  useEffect(() => {
    if (!camConnected) {
      setExposure(null);
      return;
    }
    let live = true;
    void usbCameraExposure()
      .then((s) => {
        if (live) setExposure(s);
      })
      .catch((err) => logMsg("warn", `Exposure read: ${String(err)}`));
    return () => {
      live = false;
    };
  }, [camConnected]);

  /** Choosing a value sends the set and takes the re-read state as the
   * truth: the control follows the body, never its own optimism. */
  const setExposureValue = async (code: number, value: number) => {
    setExposureBusy(true);
    try {
      setExposure(await usbCameraSetExposure(code, value));
    } catch (err) {
      logMsg("error", String(err));
    } finally {
      setExposureBusy(false);
    }
  };

  const capture = async () => {
    setBusy("capture");
    livePause.current = true;
    try {
      const d = dials.current;
      const got = await usbCameraCapture({ dest: d.dest, pattern: d.pattern, collection: d.collection, af: afOnCapture });
      absorb(got.images, got.session_count);
      logMsg("info", "Captured frame imported");
      // Auto modes can move a value per shot; re-read so the controls
      // stay with the body.
      setExposure(await usbCameraExposure().catch(() => exposure));
    } catch (err) {
      logMsg("error", String(err));
    } finally {
      livePause.current = false;
      setBusy(null);
    }
  };

  const copyDiagnostics = () => {
    const text = [scan?.report ?? "", ...(cam?.report_lines ?? [])].filter(Boolean).join("\n");
    if (!text) return;
    // navigator.clipboard needs a secure context; the console copy is
    // the fallback and already holds the same lines.
    if (navigator.clipboard) {
      void navigator.clipboard
        .writeText(text)
        .then(() => logMsg("info", "Camera diagnostics copied"))
        .catch(() => logMsg("warn", "Clipboard refused; the same lines are in the console log"));
    } else {
      logMsg("warn", "No clipboard here; the same lines are in the console log");
    }
  };

  return (
    <div data-testid="tether-tab" style={{ padding: "10px 12px", overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 7 }}>
      {/* The truth, first, where it is read before the camera comes
          out. Folded, but the label carries the gist: early preview. */}
      <Fold label="DISCLAIMER: Early Preview" testid="tether-disclaimer">
        The folder watch below works with any camera whose vendor software writes
        into a folder. Direct USB capture is new, built against a Panasonic Lumix, and other bodies
        are untested: I cannot test every camera and lens, so what works beyond it comes from your
        reports. Copy Diagnostics below is the report to send. Send diagnostics and feedback about
        the tether tool to support@heeler.app.
      </Fold>

      <div className="kicker">SESSION</div>
      <Row label="Watch folder">
        <FolderLine
          value={hot}
          placeholder="Pick a folder to watch…"
          testid="tether-hot"
          onPick={() => void pickExportFolder().then((p) => p && setHot(p))}
        />
      </Row>
      <Fold label="About" testid="tether-hot-note">
        Only needed when the camera's own tether software (LUMIX Tether, EOS Utility, …) writes
        photos to disk: point this at the folder it writes into, and every arrival imports. With a
        camera connected over USB below, frames come straight off the body and this stays empty.
      </Fold>
      <Row label="Destination">
        <FolderLine
          value={dest}
          placeholder="Set the folder the photos will write to"
          testid="tether-dest"
          onPick={() => void pickExportFolder().then((p) => p && setDest(p))}
          onClear={() => setDest(null)}
        />
      </Row>
      <Row label="Naming">
        <input
          data-testid="tether-pattern"
          value={pattern}
          placeholder="{date}-{seq}-{name}"
          data-hint="Applied on ingest. Tokens: {name} original, {seq} session counter, {date} YYYYMMDD. Empty keeps the original name; nothing is ever overwritten."
          spellCheck={false}
          style={{ background: "var(--bg-app)", border: "1px solid var(--line-4)", color: "var(--text-body)", fontSize: 10, padding: "2px 5px", outline: "none", minWidth: 0 }}
          onChange={(e) => setPattern(e.target.value)}
        />
      </Row>
      <Row label="Collection">
        <MenuField
          testid="tether-collection"
          label="Add arrivals to collection"
          size="regular"
          value={collection === null ? "" : String(collection)}
          options={[{ id: "", label: "None" }, ...state.collections.map((c) => ({ id: String(c.id), label: c.name }))]}
          onChange={(id) => setCollection(id === "" ? null : Number(id))}
        />
      </Row>
      <Row label="Advance">
        <button
          className="chip"
          data-testid="tether-advance"
          data-active={advance}
          aria-pressed={advance}
          data-hint="Each arrival becomes the active photograph the moment it lands"
          style={{ fontSize: 10, padding: "1px 8px", justifySelf: "start" }}
          onClick={() => setAdvance((v) => !v)}
        >
          {advance ? "On" : "Off"}
        </button>
      </Row>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2 }}>
        {!running ? (
          <button
            className="chip"
            data-testid="tether-start"
            disabled={!hot || !isTauri()}
            data-hint="Starts watching the folder for new frames"
            style={{ fontSize: 10, padding: "2px 12px" }}
            onClick={() => void start()}
          >
            START SESSION
          </button>
        ) : (
          <button
            className="chip"
            data-testid="tether-stop"
            data-active
            data-hint="Stops watching; frames already imported stay"
            style={{ fontSize: 10, padding: "2px 12px" }}
            onClick={() => void stop()}
          >
            STOP
          </button>
        )}
        <div data-testid="tether-status" style={{ fontSize: 11, color: "var(--text-faint)", letterSpacing: ".06em", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {running ? `Watching · ${count} in${last ? ` · last ${last}` : ""}` : hot ? "Ready" : ""}
        </div>
      </div>
      {!running && (
        <div data-testid="tether-start-note" style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5, marginTop: -3 }}>
          START SESSION watches the Watch folder for arrivals. A camera connected over USB below
          needs no Start: its frames land on their own.
        </div>
      )}

      <div className="kicker" style={{ marginTop: 8 }}>
        CAMERA
      </div>
      {cam?.connected ? (
        <>
          <div data-testid="tether-camera-status" style={{ fontSize: 10, color: "var(--text-body)", lineHeight: 1.5 }}>
            {cam.name}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.45 }}>
            Watching the card: frames you shoot on the camera land here
            {captureDest ? "" : " once you choose a Destination or a Watch folder"}.
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              className="chip"
              data-testid="tether-capture"
              disabled={busy !== null || !cam.can_capture || !captureDest}
              data-hint={
                !cam.can_capture
                  ? "This body offers no remote capture in its current USB mode; on Lumix, pick PC tether / PC Remote on the camera"
                  : !captureDest
                    ? "Choose a Destination or a Watch folder first: the frame needs somewhere to land"
                    : "Fires the shutter; the frame lands through the session import path"
              }
              style={{ fontSize: 10, padding: "2px 12px" }}
              onClick={() => void capture()}
            >
              {busy === "capture" ? "CAPTURING…" : "CAPTURE"}
            </button>
            <button
              className="chip"
              data-testid="tether-liveview"
              data-active={liveOn}
              aria-pressed={liveOn}
              data-hint="Streams the body's live view into the panel; the rate shown is measured, not promised"
              style={{ fontSize: 10, padding: "2px 12px" }}
              onClick={() => void liveToggle()}
            >
              {liveOn ? "STOP LIVE VIEW" : "LIVE VIEW"}
            </button>
            <button
              className="chip"
              data-testid="tether-disconnect"
              data-hint="Closes the camera session and releases the USB interface"
              style={{ fontSize: 10, padding: "2px 9px" }}
              onClick={() => void disconnect()}
            >
              DISCONNECT
            </button>
          </div>
          {liveOn && (
            <div data-testid="tether-liveview-box" style={{ marginTop: 2 }}>
              {liveFrame ? (
                <img
                  data-testid="tether-liveview-frame"
                  src={liveFrame}
                  alt="Camera live view"
                  style={{ width: "100%", display: "block", borderRadius: 2 }}
                />
              ) : (
                <div style={{ fontSize: 11, color: "var(--text-faint)" }}>Starting the stream…</div>
              )}
              <div data-testid="tether-liveview-fps" style={{ fontSize: 11, color: "var(--text-faint)", letterSpacing: ".06em", marginTop: 2 }}>
                {liveFps !== null ? `${liveFps.toFixed(1)} fps measured` : "measuring…"}
              </div>
            </div>
          )}
          {/* Focus drive (phase 4): the body's own table, proven on the
              DC-S5 over a running stream, with autofocus on demand in
              the middle. The body refuses every drive with the stream
              off, so the buttons stay off until live view runs. Left
              drives closer, right drives farther; one chevron is a
              small step, two is a big one, and the brackets in the
              middle are one autofocus sweep.

              No label on the row: five drawn buttons across the panel's
              full width read as focus at a glance, and the word was
              taking the space that let them spread evenly. */}
          <div
            data-testid="tether-focus"
            style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 4, marginTop: 2 }}
          >
            {(
              [
                [4, "near", true, "Focus closer, big step"],
                [3, "near", false, "Focus closer, small step"],
              ] as const
            ).map(([mode, dir, big, hint]) => (
              <button
                key={mode}
                className="chip"
                data-testid={`tether-focus-${mode}`}
                disabled={!liveOn}
                aria-label={hint}
                data-hint={liveOn ? hint : "Focus drive works over the live view stream; turn LIVE VIEW on first"}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3px 0" }}
                onClick={() => void focusDrive(mode)}
              >
                <FocusChevrons dir={dir} big={big} />
              </button>
            ))}
            {/* Autofocus on demand (verified on the DC-S5: the lens
                sweeps, the body answers 0xC104). Same stream gate as
                the drive buttons; a body in MF refuses and the log
                says to switch to AF. */}
            <button
              className="chip"
              data-testid="tether-af"
              disabled={!liveOn}
              aria-label="Autofocus"
              data-hint={liveOn ? "Run one autofocus sweep; the body or lens must be in AF" : "Autofocus works over the live view stream; turn LIVE VIEW on first"}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3px 0" }}
              onClick={() => void autofocus()}
            >
              <AutofocusIcon />
            </button>
            {(
              [
                [2, "far", false, "Focus farther, small step"],
                [1, "far", true, "Focus farther, big step"],
              ] as const
            ).map(([mode, dir, big, hint]) => (
              <button
                key={mode}
                className="chip"
                data-testid={`tether-focus-${mode}`}
                disabled={!liveOn}
                aria-label={hint}
                data-hint={liveOn ? hint : "Focus drive works over the live view stream; turn LIVE VIEW on first"}
                style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3px 0" }}
                onClick={() => void focusDrive(mode)}
              >
                <FocusChevrons dir={dir} big={big} />
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2 }}>
            <div className="lbl" style={{ fontSize: 11 }}>AF on capture</div>
            <button
              className="chip"
              data-testid="tether-af-on-capture"
              data-active={afOnCapture}
              aria-pressed={afOnCapture}
              data-hint="Runs one autofocus sweep before each capture; a body already in AF focuses on its own, and a body in MF refuses the sweep but still fires"
              style={{ fontSize: 10, padding: "1px 8px", justifySelf: "start" }}
              onClick={() => setAfOnCapture((v) => !v)}
            >
              {afOnCapture ? "On" : "Off"}
            </button>
          </div>
          {!cam.can_capture && (
            <div data-testid="tether-camera-no-capture" style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
              This body offers no remote shutter in its current USB mode, so the CAPTURE button
              stays off; the card watch above still works. On Lumix bodies, USB mode PC tether /
              PC Remote is what unlocks remote capture: pick it on the camera, then disconnect and
              connect again.
            </div>
          )}
          {exposure && (exposure.controls.length > 0 || exposure.failed.length > 0) && (
            <div data-testid="tether-exposure" style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 2 }}>
              {exposure.controls.map((c) => (
                <div key={c.key} className="srow" style={{ gridTemplateColumns: "64px 1fr" }}>
                  <div className="lbl">{c.label}</div>
                  <MenuField
                    testid={`tether-exposure-${c.key}`}
                    label={c.label}
                    hint="The choices are the body's own list for its current mode; changing one sets the camera and re-reads"
                    size="regular"
                    disabled={exposureBusy}
                    value={String(c.current)}
                    // The current value can sit outside the list (auto
                    // modes); it still shows, labeled as current.
                    placeholder={`${fmtExposure(c.key, c.current)} (current)`}
                    options={c.allowed.map((v) => ({ id: String(v), label: fmtExposure(c.key, v) }))}
                    onChange={(id) => void setExposureValue(c.code, Number(id))}
                  />
                </div>
              ))}
              {exposure.failed.map((name) => (
                <div key={name} data-testid="tether-exposure-failed" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  The body did not answer for {name.toLowerCase()}.
                </div>
              ))}
              {exposure.battery !== null && (
                <div data-testid="tether-battery" style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  Battery {exposure.battery}%
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              className="chip"
              data-testid="tether-refresh"
              disabled={busy === "scan"}
              data-hint="Re-scans the USB bus for cameras"
              style={{ fontSize: 10, padding: "2px 9px" }}
              onClick={() => void refresh()}
            >
              {busy === "scan" ? "SCANNING…" : "REFRESH"}
            </button>
            <button
              className="chip"
              data-testid="tether-copy-diagnostics"
              disabled={!scan}
              data-hint="Copies the scan report for a bug report; this is how bodies neither of us owns get supported"
              style={{ fontSize: 10, padding: "2px 9px" }}
              onClick={copyDiagnostics}
            >
              COPY DIAGNOSTICS
            </button>
          </div>
          <div data-testid="tether-device-list" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {!scan ? (
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>Scanning the USB bus…</div>
            ) : scan.devices.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5 }}>
                No camera seen on USB. Check the cable, that the body is on, and that its USB mode
                offers PTP / PC Remote rather than charging or card reader.
              </div>
            ) : (
              scan.devices.map((d) => (
                <div
                  key={d.key}
                  data-testid={`tether-device-${d.key}`}
                  style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "2px 6px", alignItems: "center" }}
                >
                  <div style={{ fontSize: 10, color: "var(--text-body)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.name} <span style={{ color: "var(--text-ghost)" }}>{`${d.vendor_id.toString(16).padStart(4, "0")}:${d.product_id.toString(16).padStart(4, "0")}`}</span>
                  </div>
                  {d.verdict === "PtpCapable" ? (
                    <button
                      className="chip"
                      data-testid={`tether-connect-${d.key}`}
                      disabled={busy !== null}
                      data-hint="Opens a PTP session and reads what the body can do"
                      style={{ fontSize: 10, padding: "1px 9px" }}
                      onClick={() => void connect(d.key)}
                    >
                      {busy === "connect" ? "CONNECTING…" : "CONNECT"}
                    </button>
                  ) : (
                    <span style={{ fontSize: 10, color: "var(--text-ghost)" }}>{VERDICT_BADGE[d.verdict]}</span>
                  )}
                  {d.verdict !== "PtpCapable" && (
                    <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "var(--text-faint)", lineHeight: 1.45 }}>{d.note}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      )}
      {/* Later phases, said in words rather than grayed controls:
          exposure control (shutter, aperture, ISO, white balance,
          focus) is phase 2, live view phase 3. Neither ships as a
          promise here. */}
      <div style={{ fontSize: 11, color: "var(--text-faint)", lineHeight: 1.5, marginTop: 2 }}>
        Coming after capture proves out: exposure control, then live view.
      </div>
    </div>
  );
}
