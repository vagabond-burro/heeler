// stackmerge.tsx's values and helpers that are not components, kept apart so
// stackmerge.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { useLayoutEffect, useState } from "react";

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
