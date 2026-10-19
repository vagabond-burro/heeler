// bake.tsx's values and helpers that are not components, kept apart so
// bake.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import type { Command, ImageEntry, State } from "../state";
import { freshGraphFor } from "../state";
import { STACK_SET_ASIDE, bakeComposite, loadGraph } from "../bridge";
import { BAKE_CANCELED, watchBake } from "./opprogress";
import { logMsg } from "../log";
import { thumbnailForNew } from "./chrome";

export type D = React.Dispatch<Command>;

/** Bakes each photograph in turn and hands back what was made.
 *
 * Sequential rather than at once, and deliberately: a full-resolution
 * merge of eight frames is gigabytes of working memory, and three of them
 * running together is how you find that out the hard way.
 */
export async function runBake(
  state: State,
  ids: string[],
  format: string,
  dispatch: D,
): Promise<ImageEntry[]> {
  const made: ImageEntry[] = [];
  for (const id of ids) {
    const entry = state.images.find(i => i.id === id);
    // While its stack merges, the bake's dialog shows the merge's card
    // (BakeProgressDialog), then its own bar.
    dispatch({ type: "set_baking", id });
    try {
      const graph = id === state.activeImage
        ? { nodes: state.nodes, wires: state.wires }
        : state.graphs[id] ?? await loadGraph(id) ?? freshGraphFor(state, id);
      // Under the bake progress dialog, with its Cancel. The desktop
      // honors Cancel before each stage; one pressed while the file is
      // being written comes too late, and the file it wrote is kept and
      // shown (nothing here deletes files), so the answer is held apart
      // from watchBake's canceled null.
      let answered: { image: ImageEntry | null } | null = null;
      await watchBake(
        `Baking ${entry?.name ?? "the photograph"}`,
        () => bakeComposite(id, format, graph, 92, entry, id !== state.activeImage).then((image) => (answered = { image })),
      );
      if (answered === null) {
        logMsg("info", "Bake canceled");
        break;
      }
      const image = (answered as { image: ImageEntry | null }).image;
      if (!image) {
        logMsg("info", "Baking needs the desktop app and a photograph on disk.");
        break;
      }
      // The edits are pixels now. Copying the recipe would apply them twice.
      const row = { ...image, edited: false };
      made.push(row);
      dispatch({ type: "add_stack_image", image: row });
      logMsg("info", `Baked ${image.name}`);
      void thumbnailForNew(image.id, dispatch, state.prefs.thumbnailEdge, image.name, image);
    } catch (e) {
      // Cancel merge on the stack the bake was waiting for ends the bake
      // too; that is a cancel, not a failure.
      const why = String(e);
      if (why.includes(STACK_SET_ASIDE) || why.includes(BAKE_CANCELED)) {
        logMsg("info", "Bake canceled");
      } else {
        logMsg("error", `Baking failed: ${why}`);
      }
      break;
    } finally {
      dispatch({ type: "set_baking", id: null });
    }
  }
  return made;
}
