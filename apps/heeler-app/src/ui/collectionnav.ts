// The way into and out of a collection: which photographs the ribbon
// holds, the label over them and which collection is open.
//
// Every path that enters or leaves a collection used to decide that for
// itself, and one that forgot left a deleted collection's photographs in
// the ribbon. Each path says here what it is (an open, a reload, a way
// out) and the rest follows.

import { loadCollection, type FolderImage } from "../bridge";
import type { Command, State } from "../state";
import { beginNavigation, currentNavigation, loadSessionImages, navStale, openFolderPlain } from "./chrome";

type D = (command: Command) => void;

function show(files: FolderImage[], id: number, label: string, dispatch: D, thumbnailEdge: number): void {
  loadSessionImages(files, dispatch, thumbnailEdge);
  dispatch({ type: "set_library", label, collection: id, path: null });
}

/** Opens a collection: its photographs in the ribbon, its name on the
 * library. Takes the navigation token so a folder restore still in
 * flight cannot land its listing on top of the collection, and drops its
 * own listing if a newer navigation came while the members loaded: a
 * folder clicked meanwhile is the newer wish, whichever answer arrives
 * first. */
export async function openCollection(id: number, label: string, dispatch: D, thumbnailEdge = 480): Promise<void> {
  const nav = beginNavigation();
  const files = await loadCollection(id);
  if (navStale(nav)) return;
  show(files, id, label, dispatch, thumbnailEdge);
}

/** Shows the open collection again after its membership changed, so the
 * ribbon tells the truth instead of showing ghosts. Not a navigation, so
 * it takes no token of its own, but it gives way to one that started
 * while it loaded: a folder clicked meanwhile must still be what shows. */
export async function reloadCollection(id: number, label: string, dispatch: D, thumbnailEdge = 480): Promise<void> {
  const nav = currentNavigation();
  const files = await loadCollection(id);
  if (navStale(nav)) return;
  show(files, id, label, dispatch, thumbnailEdge);
}

/** The folder a way out of the open collection leads back to: the one
 * the library was in before it. Opening a collection sets
 * activeFolderPath to null, so the panel remembers the last folder on
 * the way past (`remembered`) for when the state no longer knows. */
export function folderBehind(s: State, remembered: string | null): string | null {
  return s.activeFolderPath ?? remembered;
}

/** Out of the open collection: back to `back` (folderBehind) when there
 * is one, otherwise to an empty ribbon. The collection's photographs
 * must not stay listed, under its name, once it is no longer open:
 * stepping off one with no folder behind it used to leave both, so
 * nothing on screen said what the ribbon held. */
export async function leaveCollection(s: State, dispatch: D, back: string | null): Promise<void> {
  if (back) {
    await openFolderPlain(back, s.folderTree, dispatch, s.prefs.thumbnailEdge);
    return;
  }
  beginNavigation();
  loadSessionImages([], dispatch, s.prefs.thumbnailEdge);
  dispatch({ type: "set_library", label: "No folder open", collection: null, path: null });
}
