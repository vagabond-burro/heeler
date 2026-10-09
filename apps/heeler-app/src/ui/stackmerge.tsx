// The canvas while a stack merges.
//
// The owner, a stack of a thousand frames froze the canvas with
// nothing to say for itself, and "the loading progress bar in the
// canvas could also give both a combination of useful feedback of what
// its doing, blended with the snarky little pre-scripted one-liners
// that the app has at boot." So two lines, the way the splash has two:
// the real state of the merge (which frame, how fast, how long to go)
// and under it a rotating dog line for character.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Command, StackMerge } from "../state";
import { cancelOperation, resumeStackMerge } from "../bridge";
import { mergeLines } from "../stackprogress";
export { mergeLines, stackEventEffects, timeLeft } from "../stackprogress";

/** Heeler is a blue heeler, and a stack is a pack of frames. */
export const STACK_QUOTES = [
  "Herding every frame into one",
  "Lining the pack up nose to tail",
  "Every frame gets a sniff",
  "No frame left behind",
  "Counting birds. Lost count. Counting again",
  "Rounding up the stragglers at the back of the burst",
  "Sit. Stay. Stack.",
  "Making one trail out of a thousand pawprints",
  "Fetching frames faster than you can throw them",
  "Patience. Even a heeler waits for the gate",
  "Sorting the flock, one pixel at a time",
  "Still quicker than developing film",
  "Chasing every pixel round the yard",
  "Good dogs merge. Great dogs merge eight cores at once",
  "Nose down, frames up",
];

/** How long each line stays up. */
const QUOTE_MS = 3200;

/** Where the canvas's center is, in the window, while `active`: the
 * card in a window-wide dialog (the stitch's, the bake's while a stack
 * merges) sits there, as the stack's own card sits over the canvas,
 * rather than at the window's center beside it (2026-10-08: "it
 * doesn't seem to be centered", then "might want to double check the
 * stacking card too"). Null with no canvas on screen: the window's
 * center then. Measured again when the window resizes. */
export function useStageCenter(active: boolean): { left: number; top: number } | null {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const measure = () => {
      const stage = document.querySelector('[data-testid="viewer-stage"]');
      const r = stage?.getBoundingClientRect();
      setAt(r && r.width > 0 && r.height > 0 ? { left: r.left + r.width / 2, top: r.top + r.height / 2 } : null);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [active]);
  return active ? at : null;
}

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
