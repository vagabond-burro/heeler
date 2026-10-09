import { useEffect, useRef } from "react";
import type { Command, State } from "../state";
import { freshGraphFor } from "../state";
import { autosaves } from "../autosave";
import { isTauri, renderThumbnail, resetImageEdits, saveGraph } from "../bridge";
import { refreshLibrary } from "./chrome";
import { logMsg } from "../log";

/** What each photograph's latest reset archived, by id, as the reset's
 * own promise: an Undo pressed while the archive is still being made
 * waits for it rather than finding nothing. Session memory, like the
 * history that can ask for it.*/
const archives = new Map<string, Promise<string | null>>();

const editedNow = (s: State, id: string) => s.images.find((i) => i.id === id)?.edited ?? false;

/** Writes back what a reset archived, for a photograph other than the
 * active one whose reset an Undo took back. The archived document is
 * the base (its takes and everything else the file held); a stash the
 * editor still holds for the photograph is newer than any file, so its
 * graph goes over the base's. Nothing is written when the photograph
 * was reset or edited again meanwhile. */
async function restoreArchived(id: string, stateRef: { current: State }, dispatch: (command: Command) => void): Promise<void> {
  const archive = archives.get(id);
  const kept = await (archive ?? Promise.resolve(null));
  if (archives.get(id) !== archive) return;
  const s = stateRef.current;
  if (s.resetPending.includes(id) || !editedNow(s, id)) return;
  let doc: Record<string, unknown> | null = null;
  if (kept) {
    try { doc = JSON.parse(kept) as Record<string, unknown>; }
    catch (error) { logMsg("error", `Could not read the edits a reset put away: ${String(error)}`); }
  }
  const stash = s.graphs[id] && !s.graphs[id].preRead ? s.graphs[id] : null;
  if (stash) {
    const versions = Array.isArray(doc?.versions) ? (doc!.versions as { id: string }[]) : (s.takes[id] ?? []);
    const activeVersion = (typeof doc?.activeVersion === "string" ? doc.activeVersion : undefined) ?? s.activeTakes[id] ?? versions[0]?.id;
    doc = {
      ...(doc ?? {}),
      nodes: stash.nodes,
      wires: stash.wires,
      backdrops: stash.backdrops,
      linkOverrides: stash.overrides ?? [],
      ...(versions.length
        ? { versions: versions.map((v) => (v.id === activeVersion ? { ...v, nodes: stash.nodes, wires: stash.wires } : v)), activeVersion }
        : {}),
    };
  }
  if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.wires)) return;
  const graph = { nodes: doc.nodes as State["nodes"], wires: doc.wires as State["wires"] };
  await saveGraph(id, doc as Parameters<typeof saveGraph>[1], true, undefined, false, s.images.find(i => i.id === id));
  if (archives.get(id) === archive) archives.delete(id);
  void refreshLibrary(dispatch).catch((error) => logMsg("error", String(error)));
  const src = await renderThumbnail({ ...stateRef.current, ...graph, activeImage: id } as State, id);
  if (src && editedNow(stateRef.current, id) && !stateRef.current.resetPending.includes(id)) {
    dispatch({ type: "set_thumb", id, src });
  }
}

/** The reset aftermath, drained from the queues the reducer fills: every
 * door that resets an image (Edit menu, hotkey, thumbnail context menu)
 * dispatches reset_image_edits, and this one place archives the saved
 * graph, drops the catalog's edited badge, and re-renders the thumbnail
 * from the fresh graph. It used to be scattered per door, and the
 * Edit-menu door had none of it. "Resetting edits does not
 * update the thumbnails." Undo of a reset drains here too:
 * restorePending names the photographs whose archived edits go back on
 * disk, badge and thumbnail with them.*/
export function ResetAftermath({ state, dispatch }: { state: State; dispatch: (command: Command) => void }) {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!isTauri() || state.resetPending.length === 0) return;
    for (const id of state.resetPending) {
      dispatch({ type: "reset_settled", id });
      // A write still queued for this photograph (a mirrored link
      // edit's, most likely) carries the graph the reset just threw
      // away; landing after the archive it would bring that graph
      // back. The queue drops it before the archive is asked for.
      autosaves.cancelPending(id);
      const previous = archives.get(id);
      const archived = resetImageEdits(id);
      // A redo can archive an empty reset marker while the original
      // archive is still arriving. Keep the original document for the
      // next undo, and invalidate a restore waiting on the older reset.
      archives.set(id, archived.then((doc) => doc ?? previous ?? null).catch(() => previous ?? null));
      void archived.then(() => refreshLibrary(dispatch)).catch((error) => logMsg("error", String(error)));
      // Through the photo's own fresh graph, which carries the
      // rendered-source bypass and the RAW profile preference; the live
      // graph is another photo's when the reset came from the ribbon.
      // An Undo that lands first owns the thumbnail: the factory one is
      // dropped once the photograph is edited again.
      void renderThumbnail({ ...stateRef.current, ...freshGraphFor(stateRef.current, id), activeImage: id } as State, id).then((src) => {
        if (src && !editedNow(stateRef.current, id)) dispatch({ type: "set_thumb", id, src });
      });
    }
  }, [state.resetPending]);
  useEffect(() => {
    if (!isTauri() || state.restorePending.length === 0) return;
    for (const id of state.restorePending) {
      dispatch({ type: "restore_settled", id });
      void restoreArchived(id, stateRef, dispatch).catch((error) => logMsg("error", `Could not put back the edits of ${id}: ${String(error)}`));
    }
  }, [state.restorePending]);
  return null;
}
