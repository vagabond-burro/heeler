// Noise Reduction's Model method: the runner that asks the desktop
// for the SCUNet answer at the preview tier whenever the section
// wants it, the consent card when the model is not installed, and
// the progress the section's status line reads. The full-frame run
// is minutes on the CPU and is asked for on purpose, from the
// section or by an export.

import React, { useEffect, useRef, useState } from "react";
import { denoiseMap, denoiseFullStatus, onDenoiseCacheChanged, modelsEpoch, onModelsChanged, onDenoiseProgress, smartModelDownload, smartModelStatus, type DenoiseFullStatus, type DenoiseProgress, type SmartModels } from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { ModelConsentCard } from "./modelconsent";
import { publishBusy } from "./statusbar";
import { MODEL_DENOISE_ID, previewEdgeFor, type Command, type State } from "../state";

type D = React.Dispatch<Command>;

export interface DenoiseStatus {
  failed?: string;
  /** a run in flight: which, and how far */
  running: { full: boolean; done: number; total: number; imageId: string; phase: "checking" | "model" } | null;
  /** the answers that landed this session, per mark */
  ready: Record<string, { preview: boolean; full: boolean; work?: "cached" | "model" }>;
}

let status: DenoiseStatus = { running: null, ready: {} };
const subs = new Set<() => void>();
function publish(next: DenoiseStatus) {
  status = next;
  for (const fn of subs) fn();
}
export function denoiseStatusNow(): DenoiseStatus {
  return status;
}
export function subscribeDenoise(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
export function retryDenoise() {
  publish({ ...status, failed: undefined });
}
export function useDenoiseStatus(): DenoiseStatus {
  const [, tick] = useState(0);
  useEffect(() => subscribeDenoise(() => tick((n) => n + 1)), []);
  return status;
}

/** The source options the model read, as the desktop keys them: a
 * white balance flip is another answer. */
export function denoiseMark(s: State): string {
  const src = s.nodes.find((n) => n.type === "heeler.image_source");
  const p = src?.params ?? {};
  const text = src?.textParams ?? {};
  return `${s.activeImage}|wb${p.camera_wb ?? 1}m${p.camera_matrix ?? 1}h${text.highlights ?? "clip"}d${text.demosaic ?? "normal"}s${text.sharpening ?? "standard"}|${previewEdgeFor(s)}|${s.prefs.modelStoreDir ?? ""}|models${modelsEpoch()}`;
}

export function denoiseWanted(s: State): boolean {
  const n = s.nodes.find((k) => k.id === MODEL_DENOISE_ID);
  return !!n && n.enabled && (n.params.method ?? 0) !== 0;
}

/** Recheck disk on mount and on source, model or cache changes. */
export function useFullDenoiseStatus(state: State, enabled = true) {
  const mark = denoiseMark(state);
  const [epoch, setEpoch] = useState(0);
  const key = `${mark}|cache${epoch}`;
  const [result, setResult] = useState<{ key: string; value: DenoiseFullStatus | null; error?: string } | null>(null);
  useEffect(() => onDenoiseCacheChanged(() => setEpoch((n) => n + 1)), []);
  useEffect(() => onModelsChanged(() => setEpoch((n) => n + 1)), []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void denoiseFullStatus(state).then((value) => { if (live) setResult({ key, value }); })
      .catch((error) => { if (live) setResult({ key, value: null, error: String(error) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return enabled && result?.key === key ? result : null;
}

function landed(state: State, dispatch: D, full: boolean, work: "cached" | "model", tiles = 0) {
  const mark = denoiseMark(state);
  const have = status.ready[mark] ?? { preview: false, full: false };
  publish({ running: null, ready: { ...status.ready, [mark]: { preview: true, full: have.full || full, work } } });
  logMsg("info", work === "cached" ? `Noise Reduction: ${full ? "full size" : "preview"} loaded from disk, no model tiles`
    : `Noise Reduction model: ${full ? "full size" : "preview"} done, ${tiles} tiles`);
  dispatch({ type: "poke_render" });
}

/** Recheck disk on a click too, so a stale button cannot request duplicate work. */
export async function requestFullDenoise(state: State, dispatch: D): Promise<void> {
  if (status.running) return;
  publish({ ...status, running: { full: true, done: 0, total: 0, imageId: state.activeImage, phase: "checking" } });
  publishBusy("DENOISE \u00b7 checking the full-size cache");
  try {
    // A cache check that cannot answer is not an answer of "no": fall
    // through to the run, which reports the real problem or asks for
    // the model, rather than failing here with nothing attempted.
    const disk = await denoiseFullStatus(state).catch(() => null);
    if (disk?.full) { landed(state, dispatch, true, "cached"); return; }
    const answer = await denoiseMap(state, null);
    landed(state, dispatch, true, answer.work, answer.tiles);
  } catch (err) {
    publish({ ...status, running: null });
    reportToolError("Noise Reduction", err);
  } finally { publishBusy(null); }
}

export function DenoiseRunner({ state, dispatch }: { state: State; dispatch: D }) {
  const wanted = denoiseWanted(state);
  const { running, failed } = useDenoiseStatus();
  const mark = denoiseMark(state);
  const disk = useFullDenoiseStatus(state, wanted);
  const done = useRef<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [needModel, setNeedModel] = useState(false);
  const [models, setModels] = useState<SmartModels | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => onModelsChanged(() => {
    done.current = {};
    setNeedModel(false);
    publish({ ...status, ready: {}, failed: undefined });
  }), []);

  useEffect(() => onDenoiseCacheChanged((cleared) => {
    if (!cleared) return;
    done.current = {};
    publish({ ...status, ready: {}, failed: undefined });
  }), []);

  // The desktop's tile-by-tile progress, for the status line.
  useEffect(
    () =>
      onDenoiseProgress((p: DenoiseProgress) => {
        if (!status.running || status.running.imageId !== p.image_id) return;
        publishBusy(`DENOISE \u00b7 running the model ${p.full ? "at full size" : "on the preview"}`);
        publish({ ...status, running: { ...status.running, full: p.full, done: p.done, total: p.total, phase: "model" } });
      }),
    [],
  );

  useEffect(() => {
    if (!wanted || running || busy || needModel || done.current[mark] || failed === mark) return;
    // Wait while the disk is being asked, but never wait forever on a
    // question that failed: an errored check falls through to the run,
    // which surfaces the error or the consent card the way it always
    // did. Gating on the answer alone made a failed check a silent
    // refusal to compute anything.
    if (!disk) return;
    if (disk.value?.full) { done.current[mark] = true; landed(state, dispatch, true, "cached"); return; }
    // A drag is one compute, not one per frame.
    if (state.gesture !== null) return;
    setBusy(true);
    publishBusy("DENOISE \u00b7 checking the preview cache");
    publish({ ...status, running: { full: false, done: 0, total: 0, imageId: state.activeImage, phase: "checking" } });
    void denoiseMap(state, previewEdgeFor(state))
      .then((answer) => {
        done.current[mark] = true;
        landed(state, dispatch, false, answer.work, answer.tiles);
      })
      .catch((err) => {
        publish({ ...status, running: null });
        if (String(err).includes("model not installed")) {
          setNeedModel(true);
          void smartModelStatus().then(setModels).catch((err) => reportToolError("Models", err));
        } else {
          publish({ ...status, failed: mark });
          reportToolError("Noise Reduction", err);
        }
      })
      .finally(() => {
        publishBusy(null);
        setBusy(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, mark, busy, needModel, state.gesture, running, failed, disk]);

  if (!wanted) return null;
  return (
    <>
      {needModel && models && (
        <ModelConsentCard
          title="NOISE REDUCTION'S MODEL METHOD NEEDS ITS MODEL"
          model={models.denoise}
          testid="denoise"
          downloading={downloading}
          place={{ position: "fixed", left: "50%", bottom: 76, transform: "translateX(-50%)", zIndex: 40 }}
          onDownload={() => {
            setDownloading(true);
            void smartModelDownload("scunet_color_real_psnr")
              .then(() => {
                logMsg("info", "SCUNet installed");
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
