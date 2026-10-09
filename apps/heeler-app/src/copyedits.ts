import { nextSaveRevision } from "./saverevision";
// Copy Edits / Paste Edits: one photo's whole graph applied to others.
//
// "Copy edits from one photo to one or more photos." Copy
// snapshots the source's graph into the clipboard
// (state.editClipboard); paste makes every target look like the source.
// The active photo is pasted through the reducer so it is undoable;
// every other target's graph file is written directly, which is the
// same file the app would load when that photo is next opened.

import { loadGraph, loadGraphResult, renderThumbnail, saveGraph, type RenderedSource } from "./bridge";
import { pasteGraphKeepingWarp, type Command, type State, type NodeCard, type Wire } from "./state";
import { sourceAspectFor } from "./framemap";

type D = (cmd: Command) => void;

/** Writes a photo's graph file without flattening its takes: the new
 * graph becomes what the CURRENT take looks like, and the alternates
 * ride along untouched. Shared by Paste Edits and quad edit, whose
 * writes both land on photos that are not open. */
export async function writeGraphKeepingTakes(
  id: string,
  graph: { nodes: unknown[]; wires: unknown[]; backdrops?: unknown[]; linkOverrides?: string[] },
  revision = nextSaveRevision(id),
  /** the edited badge to leave; a paste or a mirrored edit is an edit,
   * a bookkeeping write (dropping link overrides) keeps what was there */
  edited = true,
  source?: RenderedSource,
): Promise<void> {
  const loaded = await loadGraphResult(id);
  if (loaded.status === "blocked") throw new Error(`${loaded.path}: ${loaded.error}`);
  const existing = loaded.status === "ready" ? loaded.graph : null;
  const lineWidth = existing?.lineWidth ?? (loaded.status === "absent" ? loaded.lineWidth : undefined);
  // The photo's link overrides stay unless the caller carries them.
  const linkOverrides = graph.linkOverrides ?? existing?.linkOverrides;
  const activeVersion = existing?.activeVersion ?? existing?.versions?.[0]?.id;
  const versions = Array.isArray(existing?.versions)
    ? existing.versions.map((v) =>
        v.id === activeVersion
          ? { ...v, nodes: graph.nodes, wires: graph.wires }
          : v,
      )
    : undefined;
  await saveGraph(
    id,
    {
      ...graph,
      ...(versions ? { versions, activeVersion } : {}),
      ...(linkOverrides ? { linkOverrides } : {}),
      // The photograph's own line thickness is not part of an edit
      // written from elsewhere; the file keeps what it had.
      ...(typeof lineWidth === "number" ? { lineWidth } : {}),
    },
    edited,
    revision,
    false,
    source,
  );
}

/** Reads a photo's graph from disk and lands it in the clipboard: the
 * copy path for a right-clicked photo that is not the active one. The
 * active photo's copy goes through the `copy_edits` reducer instead,
 * because its live graph is newer than anything on disk. */
export async function copyEditsFrom(
  state: State,
  dispatch: D,
  id: string,
): Promise<boolean> {
  if (id === state.activeImage) {
    dispatch({ type: "copy_edits" });
    return true;
  }
  const g = (await loadGraph(id)) as {
    nodes: unknown[];
    wires: unknown[];
    backdrops?: unknown[];
  } | null;
  if (!g) return false; // never edited: nothing to carry
  dispatch({
    type: "set_edit_clipboard",
    clipboard: {
      nodes: g.nodes as never,
      wires: g.wires as never,
      backdrops: (g.backdrops ?? []) as never,
      sourceId: id,
      sourceName: state.images.find((i) => i.id === id)?.name ?? "",
    },
  });
  return true;
}

/** Pastes the clipboard onto every target. Returns how many were
 * written, so the caller can log something honest. */
export async function pasteEditsTo(
  state: State,
  dispatch: D,
  targets: string[],
): Promise<number> {
  const clip = state.editClipboard;
  if (!clip) return 0;
  let pasted = 0;
  for (const id of [...new Set(targets)]) {
    if (id === clip.sourceId) continue; // already looks like itself
    if (id === state.activeImage) {
      dispatch({ type: "paste_edits" });
      pasted++;
      continue;
    }
    const saved = await loadGraph(id);
    const target = state.graphs[id] ?? saved;
    const graph = pasteGraphKeepingWarp(clip, {
      nodes: (target?.nodes ?? []) as NodeCard[], wires: (target?.wires ?? []) as Wire[],
    }, sourceAspectFor(id));
    await writeGraphKeepingTakes(id, {
      ...graph,
      backdrops: clip.backdrops,
    }, undefined, true, state.images.find(i => i.id === id));
    dispatch({ type: "mark_edited", id });
    // The ribbon should show the paste without opening the photo: render
    // its thumbnail through the pasted graph, not the active photo's.
    const src = await renderThumbnail(
      { ...state, ...graph } as State,
      id,
    );
    if (src) dispatch({ type: "set_thumb", id, src });
    pasted++;
  }
  return pasted;
}
