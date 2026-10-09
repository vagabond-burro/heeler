// Dropping a node into the graph: a helper, not a component, in a file
// of its own so Vite's Fast Refresh can hot-swap chrome.tsx (a module
// that exports both components and plain functions cannot be
// refreshed and falls back to a full reload: "addNodeAt export is
// incompatible").
import type { NodeSpec } from "../nodes";
import type { NodeRecipe } from "../noderecipes";
import { makeNode } from "../nodes";
import type { Command, State } from "../state";

type D = (cmd: Command) => void;

/** Drops a node into the graph and remembers it.
 *
 * Shared by the Node menu, the graph's own context menu and the palette,
 * so all three place a node the same way and all three feed the same
 * recents list. Positioned in graph coordinates, undoing the current pan
 * and zoom, or a node added while scrolled away lands somewhere the user
 * is not looking.
 */
export function addNodeAt(
  state: State,
  dispatch: D,
  spec: NodeSpec,
  screenX?: number,
  screenY?: number
) {
  const view = state.graphView;
  const x =
    screenX === undefined ? (200 - view.x) / view.zoom : (screenX - view.x) / view.zoom;
  const y =
    screenY === undefined ? (140 - view.y) / view.zoom : (screenY - view.y) / view.zoom;
  const id = `${spec.type.replace("heeler.", "")}_${Math.random().toString(36).slice(2, 7)}`;
  // The spot is only where the card would like to be: the reducer steps
  // it free of every card already there, so two adds in a row never
  // stack (2026-09-28). With no pointer (the palette from the toolbar
  // or its key, the Node menu) it goes right of the selected card, the
  // next link of the chain, before the view's own spot.
  const surface = document.querySelector<HTMLElement>('[data-testid="graph-surface"]');
  dispatch({
    type: "add_node",
    node: makeNode(spec, id, Math.round(x), Math.round(y)),
    ...(surface ? { viewport: { width: surface.clientWidth, height: surface.clientHeight } } : {}),
    place: screenX === undefined || screenY === undefined ? "beside" : "at",
  });
  dispatch({ type: "note_recent_node", nodeType: spec.type });
}

/** Drops a node recipe (noderecipes.ts) the same way: a new group where
 * the pointer was, in graph coordinates, or the view's own spot when
 * nothing pointed. The reducer steps it free of every card there and
 * changes nothing else. */
export function addRecipeAt(
  state: State,
  dispatch: D,
  recipe: NodeRecipe,
  screenX?: number,
  screenY?: number
) {
  const view = state.graphView;
  const x = screenX === undefined ? (200 - view.x) / view.zoom : (screenX - view.x) / view.zoom;
  const y = screenY === undefined ? (140 - view.y) / view.zoom : (screenY - view.y) / view.zoom;
  dispatch({ type: "add_recipe", recipe, x, y });
}

