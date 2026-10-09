// The tag widgets under a thumbnail: the five stars and the pick and
// reject flags, with the one routine that applies a tag to whatever it
// should land on. A leaf module, so the filmstrip (chrome.tsx) and the
// picture browser's grid (catalogview.tsx) draw the same row
// (2026-09-15: "The picture browser should show the ratings on each
// thumbnail").

import React from "react";
import type { Command, ImageEntry, State } from "../state";
import { persistFlag, persistRating } from "../bridge";

type D = React.Dispatch<Command>;

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

/** Five clickable stars under a thumbnail.
 *
 * Clicking the star a photo already has clears the rating, which is the
 * only way to get back to zero with the mouse and matches what every
 * other library does. */
export function StarRow({
  img,
  active,
  state,
  dispatch,
}: {
  img: ImageEntry;
  active: boolean;
  state: State;
  dispatch: D;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 1 }} data-testid={`stars-${img.id}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          type="button"
          className="thumb-action"
          key={n}
          aria-pressed={img.stars === n}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          data-testid={`star-${img.id}-${n}`}
          data-on={n <= img.stars}
          data-hint={`Rate ${n} star${n === 1 ? "" : "s"}`}
          data-hint-cmd={`rate.${n}`}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={(e) => {
            // The thumbnail underneath selects on click; a star is a
            // rating, not a selection.
            e.stopPropagation();
            tagImages(state, dispatch, img, { stars: img.stars === n ? 0 : n });
          }}
          style={{
            fontSize: 9,
            lineHeight: 1,
            cursor: "pointer",
            padding: "1px 0",
            color: n <= img.stars ? (active ? "var(--accent)" : "var(--text-dim)") : "var(--slot-empty)",
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/** The pick mark: a checkmark, at the size asked for. */
export function PickMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M2.5 8.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

/** Pick and reject on the thumbnail. Always visible rather than only
 * when set, so there is somewhere to click to set one. */
export function FlagToggle({ img, state, dispatch }: { img: ImageEntry; state: State; dispatch: D }) {
  const cell = (flag: "pick" | "reject", glyph: React.ReactNode, color: string, size = 9) => (
    <button
      type="button"
      className="thumb-action"
      aria-pressed={img.flag === flag}
      aria-label={flag}
      data-testid={`flag-${img.id}-${flag}`}
      data-on={img.flag === flag}
      data-hint={flag === "pick" ? "Pick" : "Reject"}
      data-hint-cmd={flag === "pick" ? "flag.pick" : "flag.reject"}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        // Clicking the flag it already has clears it, same as U.
        tagImages(state, dispatch, img, { flag: img.flag === flag ? "" : flag });
      }}
      style={{
        fontSize: size,
        lineHeight: 1,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        color: img.flag === flag ? color : "var(--slot-empty)",
      }}
    >
      {glyph}
    </button>
  );
  // The reject is the heavy cross, a size up. The light one at the
  // stars' size was a hairline that a rejected photo could hide
  // behind. "The reject symbol 'x' feels smaller than the
  // stars and it's hard to see when a photo is rejected."
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
      {/* The pick is a checkmark. The ⚑ glyph spent its height on a pole nobody
could see at this size and shrank the flag to fit it; (2026-09-15)
first asked for the flag alone, then: "Let's change it from a flag to a
checkmark". Drawn, at the stars' height.*/}
      {cell("pick", <PickMark size={10} />, "var(--pick)")}
      {cell("reject", "✖", "var(--reject)", 11)}
    </span>
  );
}

