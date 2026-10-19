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
import { publishBusy } from "./statusbarparts";
import type { Command, State, NodeCard } from "../state";
import { DEPTH_SHEET_DELAY_MS, depthEstimate, depthFailureNow, depthFromFile, depthGeometryKey, depthInlineShown, depthProgressNow, depthRecipeKey, depthWanted, dismissDepthFailure, failure, passesOf, publishFailure, publishProgress, recordDepthTiming, shiftInline, subscribeDepthProgress } from "./depthtoolparts";

type D = React.Dispatch<Command>;

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
  const mark = `${state.activeImage}|${recipe}|${state.depthEpoch}|${depthGeometryKey(state)}`;
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
  // The photograph open now, for a read that answers after a switch.
  const openImage = useRef(state.activeImage);
  openImage.current = state.activeImage;
  // An error read for another photograph stands down when this one opens.
  useEffect(() => {
    if (failure && failure.image !== state.activeImage) publishFailure(null);
  }, [state.activeImage]);
  useEffect(() => {
    if (!wanted || busy || needModel || state.gesture !== null) return;
    if (done.current[mark]) return;
    setBusy(true);
    const image = state.activeImage;
    const label = fromFile
      ? recipe === "raw"
        ? "Reading the depth pass from the file"
        : "Reading the file's depth pass and refining it"
      : recipe === "raw"
        ? "Reading the scene's depth"
        : "Reading and refining the depth map";
    publishBusy(`DEPTH · ${label.toLowerCase()}`);
    const startedAt = Date.now();
    publishFailure(null);
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
          // Shown only while its photograph is still the one open; the
          // log keeps it either way.
          if (openImage.current === image) publishFailure({ image, message: String(err) });
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
  return (
    <>
      <DepthProgressSheet />
      {wanted && needModel && models && (
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
export function DepthProgressBar({
  testid = "depth-progress",
  inline = true,
  fontSize = 7.65,
}: {
  /** prefix for every testid inside, so the sheet's copy keeps its own */
  testid?: string;
  /** the Depth Map section's own bar, which stands the sheet down while
   * it is on screen; the sheet's copy is not */
  inline?: boolean;
  fontSize?: number;
} = {}) {
  const p = React.useSyncExternalStore(subscribeDepthProgress, depthProgressNow, depthProgressNow);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!inline) return;
    const el = root.current;
    // Without an IntersectionObserver (the test runner's DOM) a mounted
    // bar counts as seen.
    if (!el || typeof IntersectionObserver === "undefined") {
      shiftInline(1);
      return () => shiftInline(-1);
    }
    // Disconnecting does not drop entries already queued, so a callback
    // can still arrive after cleanup: it is ignored, and the bar's count
    // is released exactly once.
    let seen = false;
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!live) return;
      const now = entries.some((e) => e.isIntersecting);
      if (now !== seen) {
        seen = now;
        shiftInline(now ? 1 : -1);
      }
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
      if (seen) shiftInline(-1);
      seen = false;
    };
  }, [inline]);
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
  // 11px at the section's 7.65px caption, in proportion at any size.
  const line = Math.round((fontSize * 11) / 7.65);
  const right = p
    ? remaining === null
      ? "first read at this size"
      : seconds(remaining)
    : last === null
      ? ""
      : `last read ${seconds(last)}`;
  return (
    <div
      ref={root}
      data-testid={testid}
      data-state={p ? "busy" : "idle"}
      role="progressbar"
      aria-label={left}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      // 85% of the panel's 9px caption, on a fixed footprint.
      style={{ margin: "2px 0 6px", fontSize, letterSpacing: ".06em", color: "var(--text-dim)", lineHeight: `${line}px` }}
    >
      <div data-testid={`${testid}-line`} style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 3, height: line, whiteSpace: "nowrap" }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{left.toUpperCase()}</span>
        <span className="tnum" data-testid={`${testid}-eta`} style={{ flex: "none" }}>
          {right.toUpperCase()}
        </span>
      </div>
      <div style={{ position: "relative", height: 3, background: "var(--line-4)", borderRadius: 2, overflow: "hidden" }}>
        {p && fraction === null && (
          <div
            data-testid={`${testid}-sweep`}
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
            data-testid={`${testid}-fill`}
            style={{ height: "100%", width: `${fraction * 100}%`, background: "var(--accent)", borderRadius: 2 }}
          />
        )}
      </div>
    </div>
  );
}

/** The depth read's progress wherever the owner is: a card above the
 * status bar, the inline bar's twin at a readable size, shown once a
 * read has run past DEPTH_SHEET_DELAY_MS and gone when it lands. It does
 * not block: editing carries on underneath, and nothing can stop a read
 * once the desktop has it, so there is no Cancel. A failed read leaves
 * the card up with the error until it is dismissed, also beside the
 * Depth Map section's own bar, which has no place for it; the progress
 * stands down while that bar is on screen. */
export function DepthProgressSheet() {
  const p = React.useSyncExternalStore(subscribeDepthProgress, depthProgressNow, depthProgressNow);
  const failed = React.useSyncExternalStore(subscribeDepthProgress, depthFailureNow, depthFailureNow);
  const inline = React.useSyncExternalStore(subscribeDepthProgress, depthInlineShown, depthInlineShown);
  const [due, setDue] = useState(false);
  useEffect(() => {
    setDue(false);
    if (!p) return;
    const t = window.setTimeout(() => setDue(true), Math.max(0, DEPTH_SHEET_DELAY_MS - (Date.now() - p.startedAt)));
    return () => window.clearTimeout(t);
  }, [p]);
  const card: React.CSSProperties = {
    position: "fixed",
    left: "50%",
    bottom: 76,
    transform: "translateX(-50%)",
    zIndex: 40,
    width: 420,
    maxWidth: "calc(100vw - 32px)",
    boxSizing: "border-box",
    background: "var(--bg-panel)",
    border: "1px solid var(--line-4)",
    padding: "12px 16px 8px",
    color: "var(--text-body)",
  };
  // A failure shows even beside the Depth Map section's own bar, which
  // has no place for it; only the progress stands down there.
  if (failed) {
    return (
      <div data-testid="depth-sheet" data-state="failed" role="alert" style={card} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ fontSize: 13, letterSpacing: ".08em", marginBottom: 4 }}>DEPTH MAP FAILED</div>
        <div data-testid="depth-sheet-error" style={{ fontSize: 12, color: "var(--text-faint)", overflowWrap: "anywhere" }}>
          {failed}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", margin: "8px 0 4px" }}>
          <button className="chip" data-testid="depth-sheet-dismiss" onClick={dismissDepthFailure}>
            DISMISS
          </button>
        </div>
      </div>
    );
  }
  if (inline > 0 || !p || !due) return null;
  return (
    <div data-testid="depth-sheet" data-state="busy" role="status" style={card} onMouseDown={(e) => e.stopPropagation()}>
      <DepthProgressBar testid="depth-sheet-progress" inline={false} fontSize={11} />
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
