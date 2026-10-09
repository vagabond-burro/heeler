import { useDialogFocus } from "./dialogfocus";
// The card shown while a panorama is being stitched.
//
// Stitching a real set of frames is not quick, and until this existed
// the only sign anything was happening was the fans spinning up. A
// progress bar that names the stage is the difference between "working"
// and "hung", and the stages are worth naming because they are wildly
// different lengths: reading RAW frames, finding features, matching
// every pair, solving the cameras, blending.
//
// It wears the stack merge card's format (2026-10-08: "the panoramic
// stitching progress should be the same format as what stacking uses"):
// the mark, a title saying what is being stitched, the bar, a detail
// line (stage, percent, time left), Cancel stitch and a rotating dog
// line. Canceled, it says so and offers Stitch again, as a canceled
// merge offers Merge again. It stays a dialog over the whole window,
// unlike the stack's card over the canvas: the stitch runs inside the
// render call, so everything else would only queue behind it.

import React, { useEffect, useRef, useState } from "react";
import type { Command, State } from "../state";
import { timeLeft } from "../stackprogress";
import { cancelOperation, resumePanoStitch } from "../bridge";
import { useStageCenter } from "./stackmerge";

type D = React.Dispatch<Command>;

/** A panorama is the yard seen in one sweep. */
export const STITCH_QUOTES = [
  "Walking the fence line, frame by frame",
  "Lining up the yard, post to post",
  "Finding where one frame's tail meets the next one's nose",
  "Every edge gets a sniff",
  "Herding the horizon into one line",
  "Matching the hills from one frame to the next",
  "Sit. Stay. Overlap.",
  "Fetching the far end of the view",
  "Patience. The whole yard does not fit in one look",
  "Blending the seams so nobody sees the gate",
];

const QUOTE_MS = 3200;

const count = (n: number) => n.toLocaleString("en-US");

/** The card's words: what is being stitched, and how far it has got.
 * Time left is the elapsed time scaled by what remains, once there is
 * enough of both to mean something. */
export function stitchLines(job: NonNullable<State["stitch"]>): { title: string; stage: string; pct: number; left: string | null } {
  const fraction = Math.max(0, Math.min(1, job.fraction));
  const title = job.frames && job.frames > 0
    ? `Stitching ${count(job.frames)} frames${job.full ? " · full resolution" : ""}`
    : "Stitching panorama";
  const seconds = (job.elapsedMs ?? 0) / 1000;
  const left = seconds >= 1.5 && fraction > 0.02 && fraction < 1 ? timeLeft((seconds * (1 - fraction)) / fraction) : null;
  return { title, stage: job.stage, pct: Math.round(fraction * 100), left };
}

export function StitchDialog({ state, dispatch }: { state: State; dispatch: D }) {
  const job = state.stitch;
  const running = !!job && job.error === null && !job.canceled;
  const focus = useDialogFocus(!!job);
  const center = useStageCenter(!!job);
  const placed = center ? { left: center.left, top: center.top } : undefined;
  const start = useRef(Math.floor(Math.random() * STITCH_QUOTES.length));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setTick((n) => n + 1), QUOTE_MS);
    return () => clearInterval(t);
  }, [running]);
  if (!job) return null;
  const failed = job.error !== null;
  const { title, stage, pct, left } = stitchLines(job);
  if (job.canceled) {
    return (
      <div data-testid="stitch-dialog" style={{ position: "fixed", inset: 0, background: "rgba(12, 11, 10, .62)", zIndex: 60 }}>
        <div ref={focus} role="dialog" aria-modal="true" aria-label="Stitch canceled" tabIndex={-1} className="stack-merge" data-testid="stitch-canceled" style={placed}>
          <img src="/heeler-icon.svg" alt="" width={44} height={44} style={{ borderRadius: 11, opacity: 0.9 }} />
          <div className="stack-merge-title" data-testid="stitch-title">Stitch canceled</div>
          <div className="stack-merge-detail">The panorama keeps its frames and settings. It stitches again only when you ask.</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="chip"
              type="button"
              data-testid="stitch-again"
              onClick={() => {
                // The backend's mark first, so the stitch the viewer
                // asks for next is not refused as canceled.
                void resumePanoStitch(job.image).then(() => dispatch({ type: "resume_pano_stitch", image: job.image }));
              }}
            >
              Stitch again
            </button>
            <button className="chip" type="button" data-testid="stitch-close" onClick={() => dispatch({ type: "set_stitch_progress", progress: null })}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="stitch-dialog"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(12, 11, 10, .62)",
        zIndex: 60,
      }}
    >
      <div ref={focus} role="dialog" aria-modal="true" aria-label={failed ? "Panorama failed" : "Stitching panorama"} tabIndex={-1} className="stack-merge" style={placed}>
        <img src="/heeler-icon.svg" alt="" width={44} height={44} style={{ borderRadius: 11, opacity: 0.9 }} />
        <div className="stack-merge-title" data-testid="stitch-title">{failed ? "Panorama failed" : title}</div>
        {!failed && (
          <div className="stack-merge-bar">
            <div data-testid="stitch-bar" style={{ width: `${pct}%` }} />
          </div>
        )}
        <div className="stack-merge-detail" data-testid="stitch-stage" aria-live="polite">
          {failed ? (
            job.error
          ) : (
            <>
              {stage} · <span data-testid="stitch-pct">{pct}%</span>
              {left ? ` · ${left}` : ""}
            </>
          )}
        </div>
        {/* Cancel stitch: the stitch stops between its units of work
            (a frame read, one frame's features, one pair, the solve, a
            frame's warp or blend) and is not started again until Stitch
            again (2026-10-08: "pano stitching is missing a cancel
            button like stacking has"). */}
        {!failed && job.jobId && (
          <button className="chip" type="button" data-testid="stitch-cancel" onClick={() => void cancelOperation(job.jobId!)}>
            Cancel stitch
          </button>
        )}
        {!failed && (
          <div className="stack-merge-quote" data-testid="stitch-quote">
            {STITCH_QUOTES[(start.current + tick) % STITCH_QUOTES.length]}
          </div>
        )}
        {failed && (
          <>
            {/* What happens now, spelled out: the backend memoizes the
                failure, so selecting the panorama again will NOT re-run
                the stitch or re-raise this dialog. "Failed Panorama
                stitches are hard to remove" - the remove path gets
                named here so it stops being a hunt. */}
            <div className="stack-merge-detail">
              It won't retry until its frames or recipe change. To discard it, right-click
              the panorama's thumbnail and choose Move to Trash.
            </div>
            <button
              className="chip"
              type="button"
              data-testid="stitch-dismiss"
              onClick={() => dispatch({ type: "set_stitch_progress", progress: null })}
            >
              Dismiss
            </button>
          </>
        )}
      </div>
    </div>
  );
}
