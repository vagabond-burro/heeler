// tether.tsx's values and helpers that are not components, kept apart so
// tether.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import { type TetherImage } from "../bridge";
import { type State } from "../state";

export const sameFolder = (a: string, b: string) =>
  a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");

/** Which arrivals belong in the list on screen. A folder view takes the
 * ones that landed in that folder; a collection view takes the ones the
 * session is adding to that collection. Everything else still moves the
 * session count and the status line, but it must not appear in a list
 * it does not belong to (and vanish on the next folder open, which was
 * the bug). */
export function arrivalsForRibbon(
  images: TetherImage[],
  state: State,
  collection: number | null,
): TetherImage[] {
  if (state.activeCollection !== null) {
    return collection !== null && collection === state.activeCollection ? images : [];
  }
  const shown = state.activeFolderPath;
  if (!shown) return [];
  return images.filter((f) => sameFolder(f.folder, shown));
}
