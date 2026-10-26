// denoisetool.tsx's values and helpers that are not components, kept apart so
// denoisetool.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React, { useEffect, useState } from "react";
import { denoiseMap, denoiseFullStatus, onDenoiseCacheChanged, modelsEpoch, onModelsChanged, type DenoiseFullStatus } from "../bridge";
import { logMsg } from "../log";
import { reportToolError } from "./hints";
import { publishBusy } from "./statusbarparts";
import { MODEL_DENOISE_ID, previewEdgeFor, type Command, type State } from "../state";

export type D = React.Dispatch<Command>;

export interface DenoiseStatus {
  failed?: string;
  /** a run in flight: which, and how far */
  running: { full: boolean; done: number; total: number; imageId: string; phase: "checking" | "model" } | null;
  /** the answers that landed this session, per mark */
  ready: Record<string, { preview: boolean; full: boolean; work?: "cached" | "model" }>;
}

export let status: DenoiseStatus = { running: null, ready: {} };

export const subs = new Set<() => void>();

export function publish(next: DenoiseStatus) {
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
  return `${s.activeImage}|wb${p.camera_wb ?? 1}m${p.camera_matrix ?? 1}h${text.highlights ?? "blend"}s${text.sharpening ?? "standard"}|${previewEdgeFor(s)}|${s.prefs.modelStoreDir ?? ""}|models${modelsEpoch()}`;
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

export function landed(state: State, dispatch: D, full: boolean, work: "cached" | "model", tiles = 0) {
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
