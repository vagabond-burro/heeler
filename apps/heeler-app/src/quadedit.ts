import { armAutosave } from "./autosave";
// Quad edit's async side: opening (member graphs come off disk) and
// the ongoing persistence of member graphs while the session runs.
// The mirroring itself is synchronous and lives in state.ts.

import { loadGraph, renderThumbnail } from "./bridge";
import { writeGraphKeepingTakes } from "./copyedits";
import type { Command, State } from "./state";

type D = (cmd: Command) => void;

/** Opens quad edit on up to four photos, first one driving. Members'
 * graphs come from the in-session stash when they have one, else from
 * their graph file; a photo never edited starts from the default look
 * (the reducer fills that in). Always lands in simple mode: quad edit
 * is an adjustments feature, and the Graph editor never shows it. */
export async function openQuadEdit(
  state: State,
  dispatch: D,
  ids: string[],
): Promise<void> {
  const sel = [...new Set(ids)];
  // Two to four, refused otherwise rather than quietly taking the first
  // four of a bigger selection: every entry point disables outside this
  // range, and this guard keeps a future one honest.
  if (sel.length < 2 || sel.length > 4) return;
  if (state.mode !== "simple") dispatch({ type: "set_mode", mode: "simple" });
  if (state.activeImage !== sel[0]) {
    // The driver must be the live graph; this also stashes whatever was
    // open before, exactly like clicking its thumbnail.
    dispatch({ type: "select_image", id: sel[0] });
  }
  const graphs: Record<
    string,
    { nodes: never[]; wires: never[]; backdrops?: never[] }
  > = {};
  for (const id of sel.slice(1)) {
    // The stash wins over disk when it holds real edits; a preRead
    // stash is only the template, so the disk read still wins there.
    if (state.graphs[id] && !state.graphs[id].preRead) continue;
    const g = (await loadGraph(id)) as {
      nodes: never[];
      wires: never[];
      backdrops?: never[];
    } | null;
    if (g) graphs[id] = g;
  }
  dispatch({ type: "open_quad_edit", ids: sel, graphs });
}

/** Saves every member's graph and refreshes its thumbnail: the debounced
 * follow-through after the reducer mirrors an edit. The driver is not
 * here; the app's normal per-image save already covers it. */
export async function persistQuadMembers(
  state: State,
  dispatch: D,
): Promise<void> {
  const q = state.quadEdit;
  if (!q) return;
  for (const [id, g] of Object.entries(state.quadGraphs)) {
    await writeGraphKeepingTakes(id, {
      nodes: g.nodes,
      wires: g.wires,
      backdrops: g.backdrops,
    }, undefined, true, state.images.find(i => i.id === id));
    dispatch({ type: "mark_edited", id });
    const src = await renderThumbnail(
      { ...state, nodes: g.nodes, wires: g.wires } as State,
      id,
    );
    if (src) dispatch({ type: "set_thumb", id, src });
  }
}

/** Members enter the same close/Retry queue at edit time, before any debounce
 * can be canceled by leaving quad edit or closing the window. */
export function queueQuadMembers(state: State, dispatch: D, delay: number): void {
  if (!state.quadEdit) return;
  for (const [id, graph] of Object.entries(state.quadGraphs)) {
    if (id === state.activeImage) continue;
    armAutosave(id, delay, async revision => {
      await writeGraphKeepingTakes(id, graph, revision, true, state.images.find(i => i.id === id));
      dispatch({ type: "mark_edited", id });
      const src = await renderThumbnail({ ...state, nodes: graph.nodes, wires: graph.wires } as State, id);
      if (src) dispatch({ type: "set_thumb", id, src });
    });
  }
}
