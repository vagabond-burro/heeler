// The memo comparator for the panes around the viewer.
//
// State.view holds the navigation-only fields (pan, zoom, view rotation,
// the ROI patch, the split divider): they move the picture on screen and
// change nothing a panel, the ribbon, the browser or the node graph
// draws. Every wheel tick and middle-drag mousemove dispatches one of
// them through the top-level reducer, and without a boundary each one
// re-rendered the ENTIRE app (thumbnail strip, folder tree, every
// slider) at pointer rate. That was the lag when navigating a
// zoomed-in photograph.
//
// The viewer reads state.view and stays unmemoized. Everything else
// wraps in React.memo with this comparator, so a nav dispatch
// reconciles the viewer subtree alone.
//
// The comparator skips exactly one key: view. A field added to
// ViewState is skipped automatically; a field added to State is
// significant automatically. The remaining rule is for authors, and
// viewmemo.test.ts enforces it: only viewer.tsx may read state.view.
// A memoized pane that read it would not re-render when it changed.

import type { State } from "../state";

/** Reference equality over every state field except the view object. */
export function stateEqualExceptView(a: State, b: State): boolean {
  if (a === b) return true;
  for (const k of Object.keys(b) as (keyof State)[]) {
    if (k === "view") continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** Props comparator for components whose only meaningful prop is state.
 * dispatch is a stable ref in this app; compared anyway, because a prop
 * the comparator forgets is a prop that can go stale. */
export function panePropsEqual<P extends { state: State; dispatch: unknown }>(
  prev: P,
  next: P,
): boolean {
  for (const k of Object.keys(next) as (keyof P)[]) {
    if (k === "state") {
      if (!stateEqualExceptView(prev.state, next.state)) return false;
    } else if (prev[k] !== next[k]) {
      return false;
    }
  }
  return true;
}
