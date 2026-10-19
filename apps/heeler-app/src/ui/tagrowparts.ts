// tagrow.tsx's values and helpers that are not components, kept apart so
// tagrow.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import type { Command, ImageEntry, State } from "../state";
import { persistFlag, persistRating } from "../bridge";

export type D = React.Dispatch<Command>;

/** Applies a rating or a flag to whatever the tag should land on, and
 * persists it. Shared by the thumbnail widgets so a click and a
 * keystroke cannot end up meaning different things. */
export function tagImages(
  state: State,
  dispatch: D,
  img: ImageEntry,
  change: { stars?: number; flag?: ImageEntry["flag"] }
) {
  // Tagging a thumbnail that is part of the selection tags the whole
  // selection; tagging one outside it is about that image alone, and
  // sweeping the whole selection would be a nasty surprise.
  const targets =
    state.imageSelection.length > 1 && state.imageSelection.includes(img.id)
      ? state.imageSelection
      : [img.id];
  if (change.stars !== undefined) {
    dispatch({ type: "set_rating", ids: targets, stars: change.stars });
    for (const id of targets) void persistRating(id, change.stars);
  }
  if (change.flag !== undefined) {
    dispatch({ type: "set_flag", ids: targets, flag: change.flag });
    for (const id of targets) void persistFlag(id, change.flag);
  }
}
