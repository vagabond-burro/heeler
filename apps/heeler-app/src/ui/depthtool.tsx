// The depth runner: computes the photograph's farness plane (with the
// Depth Map's model, V2 Small or DA3 Mono Large) the first time any depth tool - Fog, Key Light,
// Depth of Field - actually says something, and pokes a render so the
// planted raster shows. One compute per photograph; the Rust side
// no-ops when the raster already exists on disk, so revisiting a
// photo costs a file stat. Consent before any download, as ever:
// name, size, license, source, nothing fetched silently.

import React, { useEffect, useRef, useState } from "react";
import { depthMap, depthSubject, filePasses, modelsEpoch, onModelsChanged, smartModelDownload, smartModelStatus, surfaceNormals, type SmartModels } from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { MenuField } from "./menufield";
import { ModelConsentCard } from "./modelconsent";
import { publishBusy } from "./statusbarparts";
import { DEPTH_MODELS, depthModelOf, depthSizesFor, depthTuned, snapDepthSize, type Command, type DepthModelId, type State, type NodeCard } from "../state";
import { inlineConsent, shiftInlineConsent, DEPTH_SHEET_DELAY_MS, depthEstimate, depthFailureNow, depthFromFile, depthGeometryKey, depthInlineShown, depthProgressNow, depthRecipeKey, depthWanted, dismissDepthFailure, failure, passesOf, publishFailure, publishProgress, recordDepthTiming, shiftInline, subscribeDepthProgress } from "./depthtoolparts";

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
  // The model the last read found missing: a read with it waits for the
  // download, a read with the other model (switched back) goes ahead.
  const model = depthModelOf(state.nodes.find((n) => n.type === "heeler.depth_map" && n.enabled));
  const [missing, setMissing] = useState<DepthModelId | null>(null);
  const needModel = !fromFile && missing === model;
  const setNeedModel = (on: boolean) => setMissing(on ? model : null);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);
  // A model installed anywhere (Preferences, the Depth Map section's
  // own card) is the answer this runner waits for.
  useEffect(() => onModelsChanged(() => setMissing(null)), []);
  // The Depth Map section shows its own card while its model is
  // missing; this one stands down meanwhile.
  const [inlineAsks, setInlineAsks] = useState(inlineConsent);
  useEffect(() => subscribeDepthProgress(() => setInlineAsks(inlineConsent)), []);
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
  const meta = DEPTH_MODELS.find((m) => m.id === model) ?? DEPTH_MODELS[0];
  const status = models?.[meta.status];
  return (
    <>
      <DepthProgressSheet />
      {wanted && needModel && status && inlineAsks === 0 && (
        <ModelConsentCard
          title={model === "v2_small" ? "THE DEPTH TOOLS NEED THEIR MODEL" : "THIS PHOTOGRAPH'S DEPTH MODEL IS NOT INSTALLED"}
          model={status}
          testid="depth"
          downloading={downloading}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload(meta.download)
              .then(() => {
                logMsg("info", `${meta.label} installed`);
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

/** Depth Lighting's Model normals, read once per photograph and develop
 * the first time an enabled Depth Lighting asks for them, then a render
 * poke so the planted raster shows. Until they land, and on a machine
 * without the model, the lights shade from the depth map's estimate.
 * Consent before the download, as for the depth model. */
export function NormalsRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const wanted = !!state.activeImage && state.nodes.some((n) => n.type === "heeler.key_light" && n.enabled && n.textParams?.normals === "model");
  const source = state.nodes.find((n) => n.type === "heeler.image_source");
  const sourceKey = JSON.stringify([
    source?.params.camera_wb ?? 1,
    source?.params.camera_matrix ?? 1,
    source?.textParams?.highlights ?? "blend",
    source?.textParams?.sharpening ?? "standard",
  ]);
  const base = `${state.activeImage}|${sourceKey}|${state.prefs.modelStoreDir ?? ""}|models${modelsEpoch()}`;
  const mark = `${base}|preview${state.previewNonce}`;
  const done = useRef<Record<string, boolean>>({});
  const ownPoke = useRef<{ base: string; nonce: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [needModel, setNeedModel] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);
  // A model installed anywhere (Preferences as well as this runner's own
  // card) is the answer this runner waits for, as the depth runners'.
  useEffect(() => onModelsChanged(() => setNeedModel(false)), []);
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
    // Our own poke advances the preview nonce too. Accept only that
    // exact next nonce; a recipe rewrite or another native refresh is
    // a new source and must ask the desktop again.
    const poke = ownPoke.current;
    if (poke && poke.base === base && state.previewNonce === poke.nonce + 1) {
      done.current[mark] = true;
      ownPoke.current = null;
    }
    if (!wanted || busy || needModel || done.current[mark]) return;
    setBusy(true);
    publishBusy("NORMALS · reading the surfaces");
    void surfaceNormals(state)
      .then((answer) => {
        done.current[mark] = true;
        // Only a raster the model just made needs the frame drawn again:
        // a cached one is already what the render plants.
        if (answer.work !== "model") return;
        ownPoke.current = { base, nonce: state.previewNonce };
        dispatch({ type: "poke_render" });
      })
      .catch((err) => {
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
        } else {
          done.current[mark] = true; // no retry loop on a broken photo
          reportToolError("Normals", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, mark, busy, needModel]);
  if (!wanted || !needModel || !models?.normals) return null;
  return (
    <ModelConsentCard
      title="MODEL NORMALS NEED THEIR MODEL"
      model={models.normals}
      testid="normals"
      downloading={downloading}
      onDownload={() => {
        setDownloading(true);
        void smartModelDownload("moge_2_vits_normal")
          .then(() => {
            logMsg("info", "MoGe-2 ViT-S installed");
            setNeedModel(false);
          })
          .catch((err) => reportToolError("Download", err))
          .finally(() => setDownloading(false));
      }}
    />
  );
}

/** The subject matte the depth view's Subject fit stretches its grays
 * to, read once per photograph and depth input while the fit is up,
 * then a render poke so the view takes it. Until it lands, and on a
 * machine without a subject matte model, the view shows the scene's
 * grays. Consent before the download, as ever: BiRefNet Lite, the
 * smaller of the two subject mattes. */
export function SubjectFitRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const wanted = !!state.activeImage && state.depthView && state.depthViewFit === "subject";
  // The matte lies on the frame the depth model reads: a new photograph
  // or new geometry ahead of the Depth Map asks again (a file stat when
  // it is already made), keyed as the depth runner keys the plane.
  const mark = `${state.activeImage}|${depthGeometryKey(state)}|${state.depthEpoch}|models${modelsEpoch()}`;
  const done = useRef<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [needModel, setNeedModel] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => onModelsChanged(() => setNeedModel(false)), []);
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
    if (!wanted || busy || needModel || state.gesture !== null || done.current[mark]) return;
    setBusy(true);
    publishBusy("DEPTH · finding the subject");
    void depthSubject(state)
      .then((answer) => {
        done.current[mark] = true;
        if (answer.work === "model") dispatch({ type: "poke_render" });
      })
      .catch((err) => {
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
        } else {
          done.current[mark] = true; // no retry loop on a broken photo
          reportToolError("Depth subject", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, mark, busy, needModel, state.gesture]);
  const model = models?.lite ?? models?.matte;
  if (!wanted || !needModel || !model) return null;
  return (
    <ModelConsentCard
      title="FITTING THE VIEW TO THE SUBJECT NEEDS THE SUBJECT MODEL"
      model={model}
      testid="depth-subject"
      downloading={downloading}
      onDownload={() => {
        setDownloading(true);
        void smartModelDownload(models?.lite ? "birefnet_lite" : "birefnet_dynamic")
          .then(() => {
            logMsg("info", "Subject matte model installed");
            setNeedModel(false);
          })
          .catch((err) => reportToolError("Download", err))
          .finally(() => setDownloading(false));
      }}
    />
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

/** The Depth Map section's Model and Detail: which model reads the
 * scene, and at which of its own sizes. Switching a photograph whose
 * Levels or depth masks were set against the old map says in one line
 * that they may land differently; the old map stays on screen until the
 * new one answers. A model that is not installed is asked for here, with
 * its size, and the download's progress shows in the card. */
export function DepthModelChoice({
  node,
  state,
  dispatch,
  part,
}: {
  node: NodeCard;
  state: State;
  dispatch: D;
  /** the section's rows hold the two apart: the model menu (with its
   * switch note and download card), or Detail's sizes; both when absent */
  part?: "model" | "detail";
}) {
  const model = depthModelOf(node);
  const size = snapDepthSize(node.params.size, model);
  const [switched, setSwitched] = useState<{ image: string | null; from: DepthModelId } | null>(null);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);
  const epoch = modelsEpoch();
  useEffect(() => {
    let live = true;
    void smartModelStatus().then((m) => {
      if (live) setModels(m);
    });
    return () => {
      live = false;
    };
  }, [epoch, model, downloading]);
  const meta = DEPTH_MODELS.find((m) => m.id === model) ?? DEPTH_MODELS[0];
  const status = models?.[meta.status];
  // V2 missing is the runner's to ask for, when a depth tool needs it,
  // as it always was; DA3 is asked for here, the moment it is chosen.
  const asking = model !== "v2_small" && !!status && !status.installed;
  useEffect(() => {
    if (!asking) return;
    shiftInlineConsent(1);
    return () => shiftInlineConsent(-1);
  }, [asking]);
  // The note belongs to the switch on this photograph.
  const note = switched && switched.image === state.activeImage && switched.from !== model ? switched.from : null;
  const label = (id: DepthModelId) => DEPTH_MODELS.find((m) => m.id === id)?.short ?? id;
  const hints: Record<DepthModelId, string> = {
    v2_small: "Depth Anything V2 Small: small and fast, the subject's outline and the scene's planes. DA3 Large reads more relief inside a subject",
    da3_mono_large: "Depth Anything 3 Mono Large: relief inside a subject (a face, a beak, a wing edge), about four times V2's time and memory",
  };
  const sizeHint = (s: number) =>
    s === 518
      ? "Read the scene at the model's own size, 518 px: fastest, the detail every other setting starts from"
      : s === 700
        ? "Read the scene at 700 px: finer edges, about twice the time"
        : s === 1036
          ? "Read the scene at 1036 px: the finest edges, about four times the time and memory"
          : s === 504
            ? "Read the scene at the model's own size, 504 px: the relief inside a subject, a second or so"
            : "Read the scene at 1008 px: the finest relief, about four times the time and several GB of memory";
  const sizes = (
      <div className="zoom-seg" role="group" aria-label="Depth detail" style={{ border: "1px solid var(--line-4)" }}>
        {depthSizesFor(model).map((s) => (
          <button
            key={s}
            data-testid={`depth-size-${s}`}
            data-active={size === s || undefined}
            aria-pressed={size === s}
            data-hint={sizeHint(s)}
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => dispatch({ type: "set_param", id: node.id, param: "size", value: s })}
          >
            {s}
          </button>
        ))}
      </div>
  );
  if (part === "detail") return sizes;
  return (
    <>
      <MenuField
        testid="depth-model"
        label="Depth model"
        hint="Which model reads the scene's depth for this photograph"
        node={node.id}
        param="model"
        value={model}
        options={DEPTH_MODELS.map((m) => ({ id: m.id, label: m.short, hint: hints[m.id] }))}
        fitLabels={DEPTH_MODELS.map((m) => m.short)}
        onChange={(id) => {
          if (id === model || !DEPTH_MODELS.some((m) => m.id === id)) return;
          if (depthTuned(state)) setSwitched({ image: state.activeImage, from: model });
          dispatch({ type: "set_text_param", id: node.id, param: "model", value: id });
        }}
      />
      {part === undefined && sizes}
      {note && (
        <div
          data-testid="depth-model-note"
          style={{ flexBasis: "100%", fontSize: 11, color: "var(--text-dim)" }}
        >
          Levels and depth masks were set on {label(note)}'s map and may land differently on {label(model)}'s.
        </div>
      )}
      {asking && status && (
        <>
          <span
            className="chip"
            data-testid="depth-model-missing"
            data-hint={`${meta.label} is not installed yet: until it is, the depth tools keep the map they had`}
            style={{ fontSize: 11, padding: "2px 8px", cursor: "default" }}
          >
            NOT INSTALLED
          </span>
          {/* Standing where the runner's card stands, at the standard
              card's size: the section is too narrow to hold it. */}
          <ModelConsentCard
            title={`${label(model)} IS NOT INSTALLED`}
            model={status}
            testid="depth-model"
            downloading={downloading}
            secondary={
              downloading
                ? undefined
                : {
                    label: "USE V2 SMALL",
                    testid: "depth-model-keep-v2",
                    onClick: () => dispatch({ type: "set_text_param", id: node.id, param: "model", value: "v2_small" }),
                  }
            }
            onDownload={() => {
              setDownloading(true);
              void smartModelDownload(meta.download)
                .then(() => logMsg("info", `${meta.label} installed`))
                .catch((err) => reportToolError("Download", err))
                .finally(() => setDownloading(false));
            }}
          />
        </>
      )}
    </>
  );
}

/** One normals choice in Develop and the inspected Depth Lighting node.
 * A file with a normals pass offers it (FILE, CAMERA) beside the model
 * and the depth map; any other photograph chooses between the depth
 * map's estimate (auto, which is all auto can mean without a pass) and
 * the model's normals. */
export function NormalsChoice({ state, node, dispatch }: { state?: State; node: NodeCard; dispatch: D }) {
  const passes = state ? passesOf(state) : null;
  const mode = node.textParams?.normals ?? "auto";
  const model = ["model", "MODEL", "Shade with the surfaces a normals model reads in the photograph: flat walls stay flat and silhouettes draw no rim; the depth map's estimate stands in until it lands"] as const;
  const choices = passes?.normals
    ? ([
        ["auto", "FILE", "Shade with the normals the render wrote into the file, when it also says which way its camera faces; else from the depth map"],
        ["camera", "CAMERA", "Treat the file's normals as camera space already, the way a compositor's Vector Transform writes them"],
        model,
        ["off", "OFF", "Shade from the depth map alone, as for any photograph"],
      ] as const)
    : ([["auto", "DEPTH", "Shade with the surfaces estimated from the depth map's slopes"], model] as const);
  // A file's own choices (camera, off) on a photograph without a pass
  // shade from the depth map, as DEPTH does: it is shown as chosen.
  const shown = passes?.normals || mode === "model" ? mode : "auto";
  return (
    <>
      <div
        className="zoom-seg"
        role="group"
        aria-label="Normals"
        data-testid="keylight-normals"
        style={{ border: "1px solid var(--line-4)" }}
      >
        {choices.map(([id, label, hint]) => (
          <button
            key={id}
            data-testid={`keylight-normals-${id}`}
            data-active={shown === id}
            aria-pressed={shown === id}
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
