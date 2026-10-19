// stitching.tsx's values and helpers that are not components, kept apart so
// stitching.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { State } from "../state";
import { timeLeft } from "../stackprogress";

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

export const count = (n: number) => n.toLocaleString("en-US");

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
