// depthtool.tsx's values and helpers that are not components, kept apart so
// depthtool.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { FilePasses, State, NodeCard } from "../state";
import { cropPreviewGraph, nodeWantsDepth, snapDepthSize } from "../state";

// --- what the Depth Map section shows while the plane is computed ----
//
// The model reports no progress (one session run is one call), so a
// true percentage is not on offer. What is: how long the last reads
// at this working size took, this session, so the section can show a
// bar that fills over that estimate and a line that says what is
// happening. (2026-09-05): eyes are on the section, not the status
// bar.

export interface DepthProgress {
  /** when the read began, ms since epoch */
  startedAt: number;
  /** what the last reads at this working size took, or null the first time */
  estimateMs: number | null;
  label: string;
}

export let progress: DepthProgress | null = null;

export const progressSubs = new Set<() => void>();

/** Recent read times by working size, this session only: a smoothed
 * average, so one slow read does not set the bar for the day. */
export const recent: Record<string, number> = {};

export function subscribeDepthProgress(f: () => void): () => void {
  progressSubs.add(f);
  return () => {
    progressSubs.delete(f);
  };
}

export function depthProgressNow(): DepthProgress | null {
  return progress;
}

// --- the floating sheet's half of the store ---------------------------
//
// A read is mostly started from somewhere other than the Depth Map
// section (a Fog dial, the View eye, Set focus), where the inline bar
// is not on screen. The sheet shows the same progress there, and the
// error when a read fails, and stands down while an inline bar is
// visible so the two never show at once.

/** The last read's error and the photograph it was read for: an error
 * belongs to its photograph, and is never shown over another one. */
export let failure: { image: string | null; message: string } | null = null;

export let inlineShown = 0;

export function publishFailure(next: { image: string | null; message: string } | null) {
  if (failure === next) return;
  failure = next;
  progressSubs.forEach((f) => f());
}

/** The last read's error, until it is dismissed, the next read starts,
 * or the photograph it was read for is no longer the one open. */
export function depthFailureNow(): string | null {
  return failure?.message ?? null;
}

export function dismissDepthFailure(): void {
  publishFailure(null);
}

/** How many inline bars are on screen now. */
export function depthInlineShown(): number {
  return inlineShown;
}

/** How long a read runs before the sheet appears: a cache confirm or a
 * refine-only pass lands well inside it, so neither flashes a sheet. */
export const DEPTH_SHEET_DELAY_MS = 500;

/** Remembers a finished read for the estimate; exported for tests. */
export function recordDepthTiming(size: string, ms: number): void {
  recent[size] = recent[size] === undefined ? ms : recent[size] * 0.6 + ms * 0.4;
}

export function depthEstimate(size: string): number | null {
  return recent[size] ?? null;
}

/** Tests only: forget the session's timings. */
export function resetDepthTimings(): void {
  for (const k of Object.keys(recent)) delete recent[k];
}

/** The Depth Map section's recipe as the desktop keys the plane by it:
 * whole percents from the enabled node, zeros without one. A change
 * here is a new plane to compute. */
export function depthRecipeKey(s: State): string {
  const n = s.nodes.find((k) => k.type === "heeler.depth_map" && k.enabled);
  if (!n) return "raw";
  const pct = (v: unknown) =>
    Math.round(Math.min(100, Math.max(0, typeof v === "number" && Number.isFinite(v) ? v : 0)));
  const size = snapDepthSize(n.params.size);
  const near = pct(n.params.near_clip);
  const far = pct(n.params.far_clip);
  // The raw plane's key, whatever the section says, when it asks for
  // nothing: the desktop keys it the same way.
  if (pct(n.params.edges) === 0 && pct(n.params.flatten) === 0 && near === 0 && far === 0 && size === 518) {
    return "raw";
  }
  return `e${pct(n.params.edges)}f${pct(n.params.flatten)}n${near}x${far}s${size}`;
}

/** What the preview's depth plane is read through: the nodes ahead of
 * the Depth Map's seat (CHAIN_ORDER: the model denoise, a merge, the
 * lens, the crop and the warps), as the graph the
 * preview renders has them (the crop opened to the whole frame while the
 * crop tool is up). The desktop keys the plane by the picture the Depth
 * Map reads, so a different geometry is a different plane to compute;
 * keyed by the recipe alone, the runner took the plane as done after a
 * crop or with the crop tool up, and a layer limited by its Depth mask
 * covered its whole shape (the owner, 2026-10-17: a radial brightening
 * meant for an owl lit its whole ellipse). The crop counts only with a
 * warp ahead of the map: otherwise the desktop reads the map before the
 * crop and cuts it to each one, so no crop asks again. */
export const AHEAD_OF_DEPTH = [
  "heeler.model_denoise",
  "heeler.merge",
  "heeler.lens_correct",
  "heeler.crop_rotate",
  "heeler.grid_warp",
  "heeler.shape_warp",
];

export function depthGeometryKey(s: State): string {
  const nodes = s.tool === "crop" ? cropPreviewGraph(s).nodes : s.nodes;
  // The desktop reads the map before the crop unless a warp is ahead of
  // it too (lib.rs lifted_depth_crops): then a crop is no new plane.
  const warped = nodes.some((n) => n.enabled && (n.type === "heeler.grid_warp" || n.type === "heeler.shape_warp"));
  const geometry = nodes
    .filter((n) => n.enabled && AHEAD_OF_DEPTH.includes(n.type) && (warped || n.type !== "heeler.crop_rotate"))
    .map((n) => [n.id, n.params, n.textParams ?? {}]);
  return JSON.stringify(geometry);
}

// The per-node predicates live in state.ts as nodeWantsDepth (26.3
// Phase 10.3): the runner and the depth wiring must agree on what a
// depth consumer at work is, and the wiring cannot import from here.

export function depthWanted(s: State): boolean {
  // The View depth eye is itself a request: the owner clicked it on a
  // freshly reset photograph and the render had nothing to show and
  // no reason to compute it - a retry loop against a wall.
  if (s.depthView) return true;
  // Recompute is a request in its own right: with no depth tool on and
  // the eye off, nothing else would ask, and the button would do
  // nothing ("I don't think recompute was firing").
  if (s.depthRecompute !== null && s.depthRecompute === s.activeImage) return true;
  // The DoF focus picker is the same kind of request: arming Set
  // focus without a computed plane made every click fail with "move a
  // depth dial first" - the picker IS the depth dial's user, so its
  // arming asks for the plane exactly as the eye does.
  if (s.dofPick) return true;
  // The depth Band's picker likewise: a click reads the plane.
  if (s.depthBandPick) return true;
  // The Recolor picker on a Depth row is the same kind of arm as the
  // DoF one: with no depth cell saying anything yet, nobody else asks
  // for the plane, and every click failed into a quiet warning
  // (2026-09-16: the eyedropper went dead after switching BY = Depth).
  if (s.recolorPick && s.recolorCell.startsWith("depth_")) return true;
  // An Export Layer fed by the depth output (Depth Map's Export
  // checkbox, or one wired by hand) writes the plane, so the plane has
  // to exist by export time: nothing else may be asking for it.
  if (
    s.wires.some(
      (w) => w.fromPort === "depth" && s.nodes.some((n) => n.id === w.to && n.enabled && n.type === "heeler.export_layer"),
    )
  ) {
    return true;
  }
  // Group members too: a Finish layer's mask sits in the Finish group,
  // and its Depth mask, looked for at the top level only, never asked
  // for the plane (its Levels sat over an empty histogram, and a layer
  // with nothing else reading depth rendered without it).
  const anyWants = (ns: NodeCard[]): boolean =>
    ns.some((n) => nodeWantsDepth(n) || (n.enabled && !!n.groupNodes && anyWants(n.groupNodes)));
  return anyWants(s.nodes);
}

/** What the active photograph's file carries beside its pixels, once
 * the desktop has said: null until then, and null for a plain image. */
export function passesOf(s: State): FilePasses | null {
  return s.filePasses?.image === s.activeImage ? s.filePasses.passes : null;
}

/** The photograph's own depth pass, when its file carries one and the
 * desktop has said so: the channel name, else null. */
export function depthFromFile(s: State): string | null {
  return passesOf(s)?.depth ?? null;
}

/** The progress the runner reports, published to the bar and the sheet. */
export function publishProgress(next: DepthProgress | null) {
  progress = next;
  progressSubs.forEach((f) => f());
}

/** One more (or one fewer) inline bar on screen. */
export function shiftInline(by: number) {
  inlineShown += by;
  progressSubs.forEach((f) => f());
}
