// The canvas while a stack merges.
//
// The owner, a stack of a thousand frames froze the canvas with
// nothing to say for itself, and "the loading progress bar in the
// canvas could also give both a combination of useful feedback of what
// its doing, blended with the snarky little pre-scripted one-liners
// that the app has at boot." So two lines, the way the splash has two:
// the real state of the merge (which frame, how fast, how long to go)
// and under it a rotating dog line for character.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Command, StackMerge } from "../state";
import { cancelOperation, resumeStackMerge } from "../bridge";
import { mergeLines } from "../stackprogress";
import { STACK_QUOTES } from "./stackmergeparts";

/** How long each line stays up. */
const QUOTE_MS = 3200;

/** `inline` is the viewer's loading view, with no frame to float over:
 * the full-size mark and no card. `style` places the card (a dialog's
 * useStageCenter). */
export function StackMergeProgress({ merge, inline = false, style }: { merge: StackMerge; inline?: boolean; style?: CSSProperties }) {
  const start = useRef(Math.floor(Math.random() * STACK_QUOTES.length));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), QUOTE_MS);
    return () => clearInterval(t);
  }, []);
  const quote = STACK_QUOTES[(start.current + tick) % STACK_QUOTES.length];
  const { title, detail, fraction } = mergeLines(merge);
  return (
    <div className={inline ? "stack-merge stack-merge-inline" : "stack-merge"} data-testid="stack-merge" role="status" aria-live="polite" style={style}>
      {inline ? (
        <img src="/heeler-icon.svg" alt="" width={72} height={72} style={{ borderRadius: 18, opacity: 0.9, marginBottom: 8 }} />
      ) : (
        <img src="/heeler-icon.svg" alt="" width={44} height={44} style={{ borderRadius: 11, opacity: 0.9 }} />
      )}
      <div className="stack-merge-title" data-testid="stack-merge-title">{title}</div>
      <div className="stack-merge-bar" data-testid="stack-merge-bar">
        <div style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
      <div className="stack-merge-detail" data-testid="stack-merge-detail">{detail}</div>
      {merge.jobId && <button className="chip" type="button" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); void cancelOperation(merge.jobId!); }}>Cancel merge</button>}
      <div className="stack-merge-quote" data-testid="stack-merge-quote">{quote}</div>
    </div>
  );
}

/** A stack whose merge the user canceled: the canvas says so and offers
 * to merge it again, rather than starting the merge over on its own
 * (2026-10-07: "canceling a merge does not cancel. it keeps
 * restarting"). Placed where the progress card was.*/
export function StackMergeCanceled({ image, dispatch, inline = false }: { image: string; dispatch: (c: Command) => void; inline?: boolean }) {
  return (
    <div className={inline ? "stack-merge stack-merge-inline" : "stack-merge"} data-testid="stack-merge-canceled" role="status">
      {inline ? (
        <img src="/heeler-icon.svg" alt="" width={72} height={72} style={{ borderRadius: 18, opacity: 0.9, marginBottom: 8 }} />
      ) : (
        <img src="/heeler-icon.svg" alt="" width={44} height={44} style={{ borderRadius: 11, opacity: 0.9 }} />
      )}
      <div className="stack-merge-title">Merge canceled</div>
      <div className="stack-merge-detail">The stack keeps its frames and method. It merges again only when you ask.</div>
      <button
        className="chip"
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          // The backend's mark first, so the frame the resume asks for
          // is not refused as canceled.
          void resumeStackMerge(image).then(() => dispatch({ type: "resume_stack_merge", image }));
        }}
      >
        Merge again
      </button>
    </div>
  );
}
