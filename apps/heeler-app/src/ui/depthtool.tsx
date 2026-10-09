// The depth runner: computes the photograph's farness plane (Depth
// Anything V2 Small) the first time any depth tool - Fog, Key Light,
// Depth of Field - actually says something, and pokes a render so the
// planted raster shows. One compute per photograph; the Rust side
// no-ops when the raster already exists on disk, so revisiting a
// photo costs a file stat. Consent before any download, as ever:
// name, size, license, source, nothing fetched silently.

import React, { useEffect, useRef, useState } from "react";
import { depthMap, filePasses, smartModelDownload, smartModelStatus, type SmartModels } from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { ModelConsentCard } from "./modelconsent";
import { publishBusy } from "./statusbar";
import type { Command, FilePasses, State, NodeCard } from "../state";
import { nodeWantsDepth, snapDepthSize } from "../state";

type D = React.Dispatch<Command>;

// --- what the Depth Map section shows while the plane is computed ----
//
// The model reports no progress (one session run is one call), so a
// true percentage is not on offer. What is: how long the last reads
// at this working size took, this session, so the section can show a
// bar that fills over that estimate and a line that says what is
// happening. (2026-09-05): eyes are on the section, not the status
// bar.

export interface DepthProgress {
  /** when the read began, ms since epoch */
  startedAt: number;
  /** what the last reads at this working size took, or null the first time */
  estimateMs: number | null;
  label: string;
}

let progress: DepthProgress | null = null;
const progressSubs = new Set<() => void>();
/** Recent read times by working size, this session only: a smoothed
 * average, so one slow read does not set the bar for the day. */
const recent: Record<string, number> = {};

function publishProgress(next: DepthProgress | null) {
  progress = next;
  progressSubs.forEach((f) => f());
}

export function subscribeDepthProgress(f: () => void): () => void {
  progressSubs.add(f);
  return () => {
    progressSubs.delete(f);
  };
}

export function depthProgressNow(): DepthProgress | null {
  return progress;
}

/** Remembers a finished read for the estimate; exported for tests. */
export function recordDepthTiming(size: string, ms: number): void {
  recent[size] = recent[size] === undefined ? ms : recent[size] * 0.6 + ms * 0.4;
}

export function depthEstimate(size: string): number | null {
  return recent[size] ?? null;
}

/** Tests only: forget the session's timings. */
export function resetDepthTimings(): void {
  for (const k of Object.keys(recent)) delete recent[k];
}

/** The Depth Map section's recipe as the desktop keys the plane by it:
 * whole percents from the enabled node, zeros without one. A change
 * here is a new plane to compute. */
export function depthRecipeKey(s: State): string {
  const n = s.nodes.find((k) => k.type === "heeler.depth_map" && k.enabled);
  if (!n) return "raw";
  const pct = (v: unknown) =>
    Math.round(Math.min(100, Math.max(0, typeof v === "number" && Number.isFinite(v) ? v : 0)));
  const size = snapDepthSize(n.params.size);
  const near = pct(n.params.near_clip);
  const far = pct(n.params.far_clip);
  // The raw plane's key, whatever the section says, when it asks for
  // nothing: the desktop keys it the same way.
  if (pct(n.params.edges) === 0 && pct(n.params.flatten) === 0 && near === 0 && far === 0 && size === 518) {
    return "raw";
  }
  return `e${pct(n.params.edges)}f${pct(n.params.flatten)}n${near}x${far}s${size}`;
}

// The per-node predicates live in state.ts as nodeWantsDepth (26.3
// Phase 10.3): the runner and the depth wiring must agree on what a
// depth consumer at work is, and the wiring cannot import from here.

export function depthWanted(s: State): boolean {
  // The View depth eye is itself a request: the owner clicked it on a
  // freshly reset photograph and the render had nothing to show and
  // no reason to compute it - a retry loop against a wall.
  if (s.depthView) return true;
  // Recompute is a request in its own right: with no depth tool on and
  // the eye off, nothing else would ask, and the button would do
  // nothing ("I don't think recompute was firing").
  if (s.depthRecompute !== null && s.depthRecompute === s.activeImage) return true;
  // The DoF focus picker is the same kind of request: arming Set
  // focus without a computed plane made every click fail with "move a
  // depth dial first" - the picker IS the depth dial's user, so its
  // arming asks for the plane exactly as the eye does.
  if (s.dofPick) return true;
  // The Recolor picker on a Depth row is the same kind of arm as the
  // DoF one: with no depth cell saying anything yet, nobody else asks
  // for the plane, and every click failed into a quiet warning
  // (2026-09-16: the eyedropper went dead after switching BY = Depth).
  if (s.recolorPick && s.recolorCell.startsWith("depth_")) return true;
  // An Export Layer fed by the depth output (Depth Map's Export
  // checkbox, or one wired by hand) writes the plane, so the plane has
  // to exist by export time: nothing else may be asking for it.
  if (
    s.wires.some(
      (w) => w.fromPort === "depth" && s.nodes.some((n) => n.id === w.to && n.enabled && n.type === "heeler.export_layer"),
    )
  ) {
    return true;
  }
  return s.nodes.some(nodeWantsDepth);
}

/** What the active photograph's file carries beside its pixels, once
 * the desktop has said: null until then, and null for a plain image. */
export function passesOf(s: State): FilePasses | null {
  return s.filePasses?.image === s.activeImage ? s.filePasses.passes : null;
}

/** The photograph's own depth pass, when its file carries one and the
 * desktop has said so: the channel name, else null. */
export function depthFromFile(s: State): string | null {
  return passesOf(s)?.depth ?? null;
}

export function DepthRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const wanted = depthWanted(state);
  // Ask once per photograph what its file carries: an OpenEXR with a
  // Z or mist pass is read, not modeled, and the section says so
  // before any depth tool asks for the plane; its Cryptomatte layers
  // are what the Object Mask picks from. The answer is only written
  // when it says something: a photograph without passes (every camera
  // file) leaves the state untouched, so nothing else in the app sees
  // a command it did not ask for.
  const asked = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const image = state.activeImage;
    if (!image || asked.current[image]) return;
    asked.current[image] = true;
    const known = state.filePasses?.image === image ? state.filePasses.passes : null;
    let live = true;
    let answered = false;
    void filePasses(state)
      .then((passes) => {
        answered = true;
        if (live && (passes !== null || known !== null)) dispatch({ type: "file_passes_known", image, passes });
      })
      .catch(() => {
        // A failed ask is not an answer: the next visit asks again.
        delete asked.current[image];
      });
    return () => {
      live = false;
      // A switch mid-flight drops the answer, so the flag must not
      // stand in for it: that photograph would otherwise show the
      // model path and "names no objects" until relaunch.
      if (!answered) delete asked.current[image];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeImage]);
  const fromFile = depthFromFile(state);
  // Per-image-and-recipe watermark: once the raster is confirmed,
  // nothing more to do for this photograph at these settings this
  // session. A moved Depth Map dial is a new key, and the runner
  // waits for the gesture to end (below) so a drag is one compute.
  const recipe = depthRecipeKey(state);
  const mark = `${state.activeImage}|${recipe}|${state.depthEpoch}`;
  const sizeKey = /s(\d+)$/.exec(recipe)?.[1] ?? "518";
  const done = useRef<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [needModel, setNeedModel] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!needModel) return;
    let live = true;
    void smartModelStatus().then((m) => {
      if (live) setModels(m);
    });
    return () => {
      live = false;
    };
  }, [needModel, downloading]);
  useEffect(() => {
    if (!wanted || busy || needModel || state.gesture !== null) return;
    if (done.current[mark]) return;
    setBusy(true);
    const label = fromFile
      ? recipe === "raw"
        ? "Reading the depth pass from the file"
        : "Reading the file's depth pass and refining it"
      : recipe === "raw"
        ? "Reading the scene's depth"
        : "Reading and refining the depth map";
    publishBusy(`DEPTH · ${label.toLowerCase()}`);
    const startedAt = Date.now();
    publishProgress({ startedAt, estimateMs: depthEstimate(sizeKey), label });
    void depthMap(state)
      .then((answer) => {
        // Only a read that ran the model teaches the estimate (the
        // desktop says which): a cache confirm is instant and a
        // refine-only pass is a filter, and recording either would
        // drag the bar's guess far under the next real read.
        if (answer.work === "model") {
          recordDepthTiming(sizeKey, Date.now() - startedAt);
        }
        done.current[mark] = true;
        setNeedModel(false);
        // A Recompute asked for this read; it is answered.
        if (state.depthRecompute === state.activeImage) dispatch({ type: "depth_settled" });
        // Nothing in the STATE changed, but the render's inputs did:
        // the farness raster is on disk now and the next frame plants
        // it.
        dispatch({ type: "poke_render" });
      })
      .catch((err) => {
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
        } else {
          done.current[mark] = true; // no retry loop on a broken photo
          reportToolError("Depth", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        publishProgress(null);
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, mark, busy, needModel, state.gesture, fromFile]);
  if (!wanted) return null;
  return (
    <>
      {needModel && models && (
        <ModelConsentCard
          title="THE DEPTH TOOLS NEED THEIR MODEL"
          model={models.depth}
          testid="depth"
          downloading={downloading}
          place={{ position: "fixed", left: "50%", bottom: 76, transform: "translateX(-50%)", zIndex: 40 }}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload("depth_anything_v2_small")
              .then(() => {
                logMsg("info", "Depth Anything V2 Small installed");
                setNeedModel(false);
              })
              .catch((err) => reportToolError("Download", err))
              .finally(() => setDownloading(false));
          }}
        />
      )}
    </>
  );
}

/** The status line in the Depth Map section, always present so the
 * section never resizes: idle, it says the map is ready and what the
 * last read took; reading, the bar fills over the session's estimate
 * for this working size, holds at nine tenths until the read lands
 * (an estimate is not a promise), and runs as a sweep the first time,
 * when there is nothing to estimate from. The words stay on one line:
 * the longest label beside "first read at this size" is wider than a
 * narrow panel, and a second line while reading is a resize. The
 * label gives way with an ellipsis; the time never does.*/
export function DepthProgressBar() {
  const p = React.useSyncExternalStore(subscribeDepthProgress, depthProgressNow, depthProgressNow);
  const [now, setNow] = useState(Date.now());
  const [last, setLast] = useState<number | null>(null);
  useEffect(() => {
    if (!p) return;
    const startedAt = p.startedAt;
    const t = window.setInterval(() => setNow(Date.now()), 100);
    return () => {
      window.clearInterval(t);
      setLast(Date.now() - startedAt);
    };
  }, [p]);
  const seconds = (ms: number) => (ms < 950 ? "under a second" : `about ${Math.max(1, Math.round(ms / 1000))} s`);
  const elapsed = p ? Math.max(0, now - p.startedAt) : 0;
  const fraction = p && p.estimateMs ? Math.min(0.9, elapsed / p.estimateMs) : null;
  const remaining = p && p.estimateMs !== null ? Math.max(0, p.estimateMs - elapsed) : null;
  const left = p ? p.label : "Depth map ready";
  const right = p
    ? remaining === null
      ? "first read at this size"
      : seconds(remaining)
    : last === null
      ? ""
      : `last read ${seconds(last)}`;
  return (
    <div
      data-testid="depth-progress"
      data-state={p ? "busy" : "idle"}
      role="progressbar"
      aria-label={left}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      // 85% of the panel's 9px caption, on a fixed footprint.
      style={{ margin: "2px 0 6px", fontSize: 7.65, letterSpacing: ".06em", color: "var(--text-dim)", lineHeight: "11px" }}
    >
      <div data-testid="depth-progress-line" style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3, height: 11, whiteSpace: "nowrap" }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{left.toUpperCase()}</span>
        <span className="tnum" data-testid="depth-progress-eta" style={{ flex: "none" }}>
          {right.toUpperCase()}
        </span>
      </div>
      <div style={{ position: "relative", height: 3, background: "var(--line-4)", borderRadius: 2, overflow: "hidden" }}>
        {p && fraction === null && (
          <div
            data-testid="depth-progress-sweep"
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              width: "30%",
              background: "var(--accent)",
              borderRadius: 2,
              left: `${((elapsed / 12) % 130) - 30}%`,
            }}
          />
        )}
        {p && fraction !== null && (
          <div
            data-testid="depth-progress-fill"
            style={{ height: "100%", width: `${fraction * 100}%`, background: "var(--accent)", borderRadius: 2 }}
          />
        )}
      </div>
    </div>
  );
}

/** One normals choice in Develop and the inspected Depth Lighting node. */
export function NormalsChoice({ state, node, dispatch }: { state?: State; node: NodeCard; dispatch: D }) {
  const passes = state ? passesOf(state) : null;
  const mode = node.textParams?.normals ?? "auto";
  return (
    <>
      <div
        className="zoom-seg"
        role="group"
        aria-label="Normals"
        data-testid="keylight-normals"
        style={{ border: "1px solid var(--line-4)" }}
      >
        {([
          ["auto", "FILE", "Shade with the normals the render wrote into the file, when it also says which way its camera faces; else from the depth map"],
          ["camera", "CAMERA", "Treat the file's normals as camera space already, the way a compositor's Vector Transform writes them"],
          ["off", "OFF", "Shade from the depth map alone, as for any photograph"],
        ] as const).map(([id, label, hint]) => (
          <button
            key={id}
            data-testid={`keylight-normals-${id}`}
            data-active={mode === id}
            aria-pressed={mode === id}
            data-hint={hint}
            style={{ fontSize: 9, padding: "2px 7px" }}
            onClick={() => dispatch({ type: "set_text_param", id: node.id, param: "normals", value: id })}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "auto" && passes?.normals && !passes.camera && (
        <span
          data-testid="keylight-normals-note"
          data-hint="World-space normals need the camera to face the right way; a file without one shades from the depth map unless you say the pass is camera space"
          style={{ fontSize: 11, letterSpacing: ".06em", color: "var(--text-dim)" }}
        >
          NO CAMERA IN THE FILE
        </span>
      )}
    </>
  );
}
