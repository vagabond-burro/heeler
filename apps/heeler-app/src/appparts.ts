// app.tsx's values and helpers that are not components, kept apart so
// app.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { startTransition } from "react";
import { maskOverlayWanted, previewTarget, settleJpegQuality } from "./state";
import type { State } from "./state";
import { serializeGraph } from "./bridge";

/** Exact request identity: the whole serialized graph, not a hash of
 * it (the second pre-merge review found two exposures whose JSON had
 * the same length and the same djb2, and a collision here shows a
 * stale full-resolution frame, not a spare render).
 * The edit counter remains a freshness guard for in-flight work, not
 * a pixel identity: Undo can restore exactly the previous graph. Source
 * identity is checked separately, because the editor's state does not
 * describe files or rasters. The preview edges are NOT part of it: a
 * settle is the whole photograph at its own pixels whatever the stage,
 * so a window step should swap the last settle back in rather than
 * render it again; the reduced tier's memory fallback cannot pass as
 * a settle because a frame with a memory notice is never remembered. */
export function settleSignature(s: State): string {
  return JSON.stringify([
    s.activeImage,
    s.previewNonce,
    serializeGraph(s),
    previewTarget(s) ?? "",
    s.gamutView,
    maskOverlayWanted(s),
    s.prefs.maskOverlayColor ?? "red",
    s.brushOverlayStrength ?? 0.5,
    settleJpegQuality(s.prefs),
  ]);
}

/** A frame lands. Mid-gesture (a slider or a stroke streaming) it
 * lands in a transition: the new picture re-renders the whole window,
 * the panels that read the frame with it, and as an ordinary update
 * that render held the main thread while the hand was still moving the
 * handle (a tester, 2026-09-30: "I do get a bit of jitter/lag on the
 * sliders"). As a transition React may split it across frames and
 * serve the handle first; it lands in the same order as the param
 * writes it follows, which ride transitions too (TrackSlider). At rest
 * a frame lands at once, as before, so a view switch never meets a
 * frame from the view it left. */
export function landFrame(snap: Pick<State, "gesture">, commit: () => void): void {
  if (snap.gesture !== null) startTransition(commit);
  else commit();
}

/** The multi-view's frames emptied, keeping the same object when they
 * already are, so React bails out instead of committing again. */
export function noFramesIfAny(prev: Record<string, string>): Record<string, string> {
  return Object.keys(prev).length === 0 ? prev : {};
}
