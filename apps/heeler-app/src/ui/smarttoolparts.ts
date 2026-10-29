// smarttool.tsx's values and helpers that are not components, kept apart so
// smarttool.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import { modLabel } from "../platform";
import type { State } from "../state";
import { smartMaskInHand } from "../state";

/** Whether a click on a depth eye is the modifier click: ALT, or CMD
 * as the layer mask eye accepts. */
export function depthEyeModifier(e: { altKey: boolean; metaKey: boolean } | undefined): boolean {
  return !!e && (e.altKey || e.metaKey);
}

/** The depth eye's status-line hint, one sentence set for every seat.
 * `mask`: the eye sits in a Depth mask block, where the modifier shows
 * that block's own mask. */
export function depthEyeHint({ red, mask = false, covering = false, maskShown = false, whose = "layer's mask" }: {
  red: boolean; mask?: boolean; covering?: boolean; maskShown?: boolean;
  /** what the block's mask is called: "layer's mask" or "set's range" */
  whose?: string;
}): string {
  const alt = modLabel("alt");
  if (maskShown) {
    return `This ${whose} shows ${red ? "in red" : "black/white"}, depth mask applied; click to see the depth map over it, ${alt}-click for ${red ? "black/white" : "red"}`;
  }
  if (covering) {
    return `Showing the depth map over this ${whose}: its mask view stays on, hidden while View depth is. Turn View depth off to see the mask, depth mask applied`;
  }
  if (mask) {
    return `Show the depth map ${red ? "as a red tint over the photograph" : "as black/white"}, white near; ${alt}-click shows this ${whose} in red, depth mask applied`;
  }
  return `Show the depth map ${red ? "as a red tint over the photograph" : "as black/white"}, white near, flipping with Invert Depth; ${alt}-click switches black/white and the red overlay`;
}

/** The six smart mask buttons' one size: a square around a 14 px
 * picture, the same for the modes and the actions. Words at 11px made
 * the row about 240 px wide and it wrapped at the default panel; as
 * pictures both sets take about 140 px and stay on one line down to
 * the narrowest Develop panel (2026-09-29: "replace all 6 button
 * labels with icons, that should reduce their horizontal width").
 * Inline, so it outranks the .zoom-seg button's `all: unset` and
 * padding.*/
export const SMART_ICON_BUTTON: React.CSSProperties = {
  width: 20,
  height: 20,
  padding: 0,
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

/** The smart mask in hand: the active Develop layer's, the active
 * Finish layer's (art masks hang off the group boundary as
 * art_m_<id> nodes), or a directly selected one - so the panel and
 * the click tool follow the user across every surface. */
export function activeSmartMask(s: State) {
  // One resolver in state.ts, which the marching ants and Polish read
  // too (antsSources).
  return smartMaskInHand(s);
}

/** A count of the Smart computes that have finished, for the viewer's
 * MASK NOT COMPUTED badge to ask its question again: a compute started
 * from the panel (Subject, Select by text, Polish's Refine edge) changes
 * nothing the badge's overlay watches when the recipe was written before
 * the pixels, so the badge asked once, before the model answered, and
 * stayed up after (2026-10-29: "I am seeing that RECOMPUTE now every
 * time I do this", Select by text). */
let smartComputed = 0;
const smartComputedListeners = new Set<() => void>();

export function noteSmartComputed(): void {
  smartComputed += 1;
  for (const fn of smartComputedListeners) fn();
}

export function useSmartComputed(): number {
  return React.useSyncExternalStore(
    (fn) => {
      smartComputedListeners.add(fn);
      return () => smartComputedListeners.delete(fn);
    },
    () => smartComputed,
    () => smartComputed,
  );
}
