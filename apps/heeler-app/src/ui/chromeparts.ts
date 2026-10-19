// chrome.tsx's values and helpers that are not components, kept apart so
// chrome.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import React from "react";
import type { Command, ImageEntry, State, TreeNode } from "../state";
import { ancestorsBetween, isPano, isStack, taggingTargets, trashConfirmAction } from "../state";
import { entryFromRow } from "../bridge";
import { catalogSaves } from "../savebarrier";
import { watchOp } from "./opprogressparts";
import { PHOTO } from "../data";
import { addToCollection, editedFolders, isTauri, lastSessionFolder, listCollections, listFolders, loadFolderSession, loadSession, loadThumbnail, openFolder, createStack, createPano, persistFlag, persistRating, removeFromCollection, saveSession, type FolderImage, type FolderListing } from "../bridge";
import { foldersWithHidden, foldersWithTrash, hiddenFolderPaths, renameFolder, missingTrashedPhotos, pickRelinkFolder, pickRelinkTarget, relinkFolder, relinkImage } from "../bridge";
import { logMsg } from "../log";
import { beginThumbSession, thumbnailGraph } from "../thumbs";
import { flashStatus } from "./hints";
import { isWithin, reloadCollection } from "./collectionnav";
import { folderWouldNotOpen, listIntoTree, regraftOldTree, restoreExpanded, revealInTree, stopExpanding, treeContains } from "./foldertree";

export type D = React.Dispatch<Command>;

/** Thumbnail loads are queued with limited concurrency: firing hundreds of
 * decode requests at once is what froze the app on big folders. Loading a
 * new session abandons the previous queue. Six, because load_thumbnail
 * went async and the workers actually run in parallel now. */
/** Turns a bridge file list into the ribbon session. Thumbnails are not
 * queued here: each cell asks for its own when it comes into view
 * (src/thumbs.ts, ThumbBox), so a folder of a thousand photographs costs
 * a screen's worth of decodes, not a thousand (2026-09-19). Shared by
 * OPEN…, folder rows, and collection rows.*/
export function loadSessionImages(files: FolderImage[], dispatch: D, thumbnailEdge = 480) {
  // The browser build has no thumbnails to fetch: a stand-in picture.
  const entries = files.map((f) => entryFromRow(f, isTauri() ? "" : PHOTO));
  dispatch({ type: "load_images", images: entries });
  beginThumbSession(dispatch, thumbnailEdge);
}

/** Re-pulls folders, collections, and edited-folder badges into state. */
export async function refreshLibrary(dispatch: D) {
  const [folders, collections, edited, hidden, trash, missing, hiddenFolders] = await Promise.all([
    listFolders(),
    listCollections(),
    editedFolders(),
    foldersWithHidden(),
    foldersWithTrash(),
    // A failed look leaves the menu item grayed rather than the library
    // unrefreshed.
    missingTrashedPhotos().catch(() => ({ ids: [], paths: [], skipped: 0, skipped_volumes: [] })),
    hiddenFolderPaths().catch(() => [] as string[]),
  ]);
  dispatch({ type: "set_folders", folders });
  dispatch({ type: "set_collections", collections });
  dispatch({ type: "set_edited_folders", paths: edited });
  dispatch({ type: "set_folders_with_hidden", paths: hidden });
  dispatch({ type: "set_folders_with_trash", paths: trash });
  dispatch({ type: "set_hidden_folders", paths: hiddenFolders });
  dispatch({ type: "set_missing_trashed", count: missing?.ids?.length ?? 0, skipped: missing?.skipped ?? 0 });
}

/** Membership errands for the ACTIVE collection, or eviction from all
 * of them at once, shared by the Photo menu and the thumbnail
 * right-click. "I should be able to add/remove a photo
 * from the currently select collection. I should also be able to
 * remove it from all collections."*/
export async function editCollectionMembership(
  state: State,
  dispatch: D,
  ids: string[],
  op: "add" | "remove" | "remove-all",
): Promise<void> {
  const col = state.collections.find((c) => c.id === state.activeCollection);
  if (op !== "remove-all" && !col) return;
  // Noted before the membership writes: a folder clicked while they run
  // is newer than this errand, and the reload must give way to it.
  const nav = currentNavigation();
  for (const id of ids) {
    const name = state.images.find((i) => i.id === id)?.name;
    if (op === "add") await addToCollection(col!.id, id, name);
    else if (op === "remove") await removeFromCollection(col!.id, id);
    else for (const c of state.collections) await removeFromCollection(c.id, id);
  }
  // Viewing a collection that just shrank: show it again.
  if (op !== "add" && col) await reloadCollection(col.id, col.name, dispatch, state.prefs.thumbnailEdge, nav);
  void refreshLibrary(dispatch);
  const n = ids.length;
  const what = `${n} photo${n === 1 ? "" : "s"}`;
  logMsg(
    "info",
    op === "add"
      ? `Added ${what} to "${col!.name}"`
      : op === "remove"
        ? `Removed ${what} from "${col!.name}"`
        : `Removed ${what} from all collections`,
  );
}

/** The folders on screen in the panel: the shortlist's and the tree's
 * open branches, the ones worth asking the disk about. */
export function visibleFolderPaths(tree: TreeNode | null, shortlist: { path: string }[]): string[] {
  const out = new Set(shortlist.map((f) => f.path));
  const walk = (n: TreeNode) => {
    out.add(n.path);
    if (n.expanded) for (const c of n.children ?? []) walk(c);
  };
  if (tree) walk(tree);
  return [...out].sort();
}

/** Applies an opened folder's listing to state: images into the ribbon,
 * subfolders into the tree. If the folder isn't in the current tree it
 * becomes a new root; otherwise its node updates in place, keeping
 * parents and siblings visible while you descend. */
export function applyFolderListing(
  listing: FolderListing,
  tree: TreeNode | null,
  dispatch: D,
  thumbnailEdge = 480,
) {
  // Applied even when the folder holds no images of its own: the ribbon
  // must show the folder that was picked, not the one before it.
  loadSessionImages(listing.images, dispatch, thumbnailEdge);
  // Anywhere under the tree's root counts, loaded or not: a folder picked
  // from deep inside the tree used to replace the root when the branch
  // down to it had not been expanded yet, and a folder in a loaded branch
  // kept it. revealInTree lists the branch first, so the node is there.
  const inTree = tree !== null && (treeContains(tree, listing.path) || isWithin(listing.path, tree.path));
  if (inTree) {
    dispatch({ type: "set_tree_node", path: listing.path, children: listing.subfolders, expanded: true });
  } else {
    stopExpanding();
    dispatch({
      type: "set_folder_tree",
      root: {
        name: listing.name,
        path: listing.path,
        expanded: true,
        children: listing.subfolders.map((s) => ({ ...s, expanded: false, children: null })),
      },
    });
  }
  dispatch({ type: "set_library", label: listing.name, collection: null, path: listing.path });
  // Remember the tree root and position, so the next launch resumes
  // here. Through the save queue like every other catalog save: the
  // command is async now, and a bare void let an older navigation's
  // record land after a newer one.
  catalogSaves.arm("session", 600, () => saveSession(inTree && tree ? tree.path : listing.path, listing.path));
}

export const leafName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? p;

/** Monotonic navigation token. Every folder pick, tree click, collection
 * view, or catalog restore takes a fresh one, and slower work in flight
 * checks it after each await: clicking around quickly must never end
 * with an older click's listing landing on top of the newer one. */
export let navToken = 0;

export function beginNavigation(): number {
  return ++navToken;
}

export const navStale = (token: number) => token !== navToken;

/** The navigation now under way, without starting one: for a refresh
 * of what is on screen that must give way to a newer navigation but is
 * not one itself. */
export function currentNavigation(): number {
  return navToken;
}

/** Expands the tree from `root` down to `folder`, opens it, and puts its
 * images in the ribbon. The tree nodes are dispatched directly rather
 * than through applyFolderListing: every path here is already known to be
 * inside the tree, so nothing needs the committed tree to decide. */
export async function descendTo(
  root: string,
  folder: string,
  dispatch: D,
  nav: number,
  thumbnailEdge: number,
  // The root the tree on screen has, for the session: re-picking a folder
  // inside the tree descends from that folder, and saving it as the root
  // made the next launch restore a different tree from the one on screen.
  treeRoot: string = root,
): Promise<FolderListing | null> {
  for (const ancestor of ancestorsBetween(root, folder)) {
    // A folder on the way that cannot be listed (gone, or on a drive
    // that went away) keeps what the tree already had for it, and still
    // opens, so the way down shows.
    const listed = await listIntoTree(ancestor, dispatch, { open: true, overtaken: () => navStale(nav) });
    if (listed.kind === "overtaken") return null;
    if (listed.kind === "failed") dispatch({ type: "set_tree_node", path: ancestor, expanded: true });
  }
  const listing = await openFolder(folder).catch(() => null);
  if (navStale(nav) || !listing || !listing.path) return null;
  dispatch({ type: "set_tree_node", path: listing.path, children: listing.subfolders, expanded: true });
  loadSessionImages(listing.images, dispatch, thumbnailEdge);
  dispatch({ type: "set_library", label: listing.name, collection: null, path: listing.path });
  catalogSaves.arm("session", 600, () => saveSession(treeRoot, listing.path));
  return listing;
}

/** Tree rows: opens exactly the clicked folder, no session memory. */
export async function openFolderPlain(
  path: string,
  tree: TreeNode | null,
  dispatch: D,
  thumbnailEdge = 480,
): Promise<void> {
  const nav = beginNavigation();
  const listing = await openFolder(path).catch((e) => {
    if (!navStale(nav)) folderWouldNotOpen(path, e, dispatch);
    return null;
  });
  if (navStale(nav) || !listing || !listing.path) return;
  await revealInTree(tree, listing.path, dispatch, nav);
  if (navStale(nav)) return;
  const newRoot = !tree || !isWithin(listing.path, tree.path);
  applyFolderListing(listing, tree, dispatch, thumbnailEdge);
  void regraftOldTree(tree, listing.path, dispatch, nav);
  if (newRoot) void restoreExpanded(listing.path, dispatch, nav);
  void refreshLibrary(dispatch);
}

/** Opens a folder the way picking one should work: the listing lands in
 * the ribbon and tree, and if this folder was worked in before, the tree
 * descends back to the subfolder and image the work stopped at. Used by
 * OPEN…, the File menu, and the folder shortlist; tree navigation stays
 * plain because a click on a row must open that row and nothing else. */
export async function openFolderRemembering(
  path: string | undefined,
  tree: TreeNode | null,
  dispatch: D,
  thumbnailEdge = 480,
): Promise<void> {
  const nav = beginNavigation();
  const listing = await openFolder(path).catch((e) => {
    if (!navStale(nav) && path) folderWouldNotOpen(path, e, dispatch);
    else if (!navStale(nav)) logMsg("error", `Could not open the folder: ${String(e)}`);
    return null;
  });
  if (navStale(nav) || !listing || !listing.path) return;
  // Where did work in this folder stop? Asked BEFORE the listing is
  // applied: applying saves the session, and that save must never be
  // allowed to overwrite the very record being restored from. (Reading
  // it after is how re-picking a folder erased its own memory and left
  // the ribbon empty.)
  const sess = await loadFolderSession(listing.path).catch(() => null);
  if (navStale(nav)) return;
  await revealInTree(tree, listing.path, dispatch, nav);
  if (navStale(nav)) return;
  const newRoot = !tree || !isWithin(listing.path, tree.path);
  applyFolderListing(listing, tree, dispatch, thumbnailEdge);
  void regraftOldTree(tree, listing.path, dispatch, nav);
  void refreshLibrary(dispatch);
  if (newRoot) await restoreExpanded(listing.path, dispatch, nav);
  if (!sess) return;
  const treeRoot = tree && isWithin(listing.path, tree.path) ? tree.path : listing.path;
  let images = listing.images;
  if (sess.activeFolder !== listing.path) {
    const sub = await descendTo(listing.path, sess.activeFolder, dispatch, nav, thumbnailEdge, treeRoot);
    if (!sub) return; // remembered folder is gone (or a newer click won); stay put
    images = sub.images;
  }
  if (navStale(nav)) return;
  if (sess.activeImage && images.some((i) => i.id === sess.activeImage)) {
    dispatch({ type: "select_image", id: sess.activeImage });
  }
}

/** Rebuilds the library from the open catalog's saved session: tree from
 * its root, ribbon from the active folder, viewer on the active image.
 * Boot runs this behind the splash (reporting progress through `onStep`),
 * and switching catalogs runs it bare, which is what makes the switch
 * visible instead of leaving the previous catalog's photos on screen.
 * Returns what it landed on, so callers know how far restore got. */
export async function restoreCatalogSession(
  dispatch: D,
  onStep?: (step: "folders" | "photos" | "image", detail?: string) => void,
  thumbnailEdge = 480,
): Promise<"photo" | "folder" | "none"> {
  const nav = beginNavigation();
  const sess = await loadSession();
  if (navStale(nav)) return "none";
  if (sess) {
    onStep?.("folders", sess.treeRoot);
    const rootListing = await openFolder(sess.treeRoot).catch(() => null);
    if (navStale(nav)) return "none";
    if (rootListing && rootListing.path) {
      applyFolderListing(rootListing, null, dispatch, thumbnailEdge);
      onStep?.("photos", `${rootListing.images.length} in ${leafName(rootListing.path)}`);
      await restoreExpanded(rootListing.path, dispatch, nav);
      if (navStale(nav)) return "none";
      let images = rootListing.images;
      if (sess.activeFolder !== sess.treeRoot) {
        onStep?.("folders", sess.activeFolder);
        const sub = await descendTo(sess.treeRoot, sess.activeFolder, dispatch, nav, thumbnailEdge);
        if (sub) {
          images = sub.images;
          onStep?.("photos", `${sub.images.length} in ${leafName(sub.path)}`);
        }
      }
      if (navStale(nav)) return "none";
      const landed = images.find((i) => i.id === sess.activeImage);
      if (landed) {
        onStep?.("image", landed.name);
        dispatch({ type: "select_image", id: landed.id });
        return "photo";
      }
      return "folder";
    }
  }
  // No saved session (or its root vanished): fall back to the most
  // recently opened folder.
  onStep?.("folders");
  const recent = await lastSessionFolder();
  if (navStale(nav)) return "none";
  if (recent) {
    const listing = await openFolder(recent.path).catch(() => null);
    if (navStale(nav)) return "none";
    if (listing && listing.path) {
      applyFolderListing(listing, null, dispatch, thumbnailEdge);
      onStep?.("photos", `${listing.images.length} in ${leafName(listing.path)}`);
      return "folder";
    }
  }
  // Nothing to restore. Say so, rather than leaving "Loading…" up as if
  // something were still coming.
  dispatch({ type: "set_library", label: "No folder open", collection: null, path: null });
  return "none";
}

/** File / Edit / Help menus in the title bar. */

/** What to call the things about to be deleted. The owner asked for a
 * "context aware menu item": a merge is a Stack, a stitch is a
 * Panorama, and a mixed selection gets the word that covers both
 * rather than picking a side.*/
export function compositeLabel(state: State, ids: string[]): string {
  const imgs = ids
    .map((id) => state.images.find((i) => i.id === id))
    .filter((i): i is ImageEntry => !!i);
  if (imgs.length === 0) return "Merge";
  if (imgs.every((i) => isPano(i))) return "Panorama";
  if (imgs.every((i) => isStack(i))) return "Stack";
  return "Merge";
}

/** Puts a freshly made composite's face in the ribbon.
 *
 * A stack or a panorama lands with no thumbnail at all: the catalog has
 * never seen it, so create_stack answers with an empty src, and the only
 * code that ever asks for one is the folder-load worker. That is why a
 * new merge sat blank until the folder was opened again, while merges
 * made weeks ago had one. "I just stacked a new image for
 * testing and it did not create a thumbnail." loadThumbnail renders it
 * through the manifest and stores it in the catalog, so it is also there
 * the next time without a second render.
 */
export async function thumbnailForNew(id: string, dispatch: D, thumbnailEdge = 480, name?: string, source?: ImageEntry): Promise<void> {
  // Through the graph the viewer opens it with, named here because the
  // image list may not hold the new merge yet.
  const src = await loadThumbnail(id, thumbnailEdge, thumbnailGraph(id, name, source)).catch(() => null);
  if (src) dispatch({ type: "set_thumb", id, src });
}

/** Merges the selected thumbnails and drops the result into the ribbon
 * beside them. Failures are reported rather than swallowed: a merge that
 * quietly does nothing is worse than one that says why. */
export async function mergeSelection(state: State, dispatch: D, mode: string) {
  const ids = state.imageSelection;
  if (ids.length < 2) return;
  try {
    const made = await createStack(ids, mode);
    if (made) {
      dispatch({ type: "add_stack_image", image: made });
      void thumbnailForNew(made.id, dispatch, state.prefs.thumbnailEdge, made.name, made);
    } else logMsg("info", "Stacking needs the desktop app: there are no source files to merge here.");
  } catch (e) {
    logMsg("error", `Stack failed: ${String(e)}`);
  }
}

/** Stitches the selected thumbnails into a panorama beside them.
 *
 * Writes the recipe and returns; the stitch itself runs when the
 * panorama is opened, the same way a stack merges at load. Nothing tells
 * it the order the frames were shot in, and any that turn out not to
 * overlap are simply left out. */
export async function stitchSelection(state: State, dispatch: D) {
  const ids = state.imageSelection;
  if (ids.length < 2) return;
  try {
    const made = await createPano(ids);
    if (made) {
      dispatch({ type: "add_stack_image", image: made });
      logMsg("info", `Stitching ${ids.length} frames into ${made.name}. Open it to see the result.`);
      void thumbnailForNew(made.id, dispatch, state.prefs.thumbnailEdge, made.name, made);
    } else {
      logMsg("info", "Stitching needs the desktop app: there are no source files here.");
    }
  } catch (e) {
    logMsg("error", `Panorama failed: ${String(e)}`);
  }
}

/** Rates whatever the tag should land on, from a menu. */
export function rateSelection(state: State, dispatch: D, stars: number) {
  const targets = taggingTargets(state);
  dispatch({ type: "set_rating", ids: targets, stars });
  for (const id of targets) void persistRating(id, stars);
}

export function flagSelection(state: State, dispatch: D, flag: ImageEntry["flag"]) {
  const targets = taggingTargets(state);
  dispatch({ type: "set_flag", ids: targets, flag });
  for (const id of targets) void persistFlag(id, flag);
}

/** What a relink says about photographs it found but left alone: the
 * file there is already in the catalog as another photograph with work
 * of its own, and one file cannot be two. A
 * blank row there is folded in instead and needs no word. */
export function takenNote(taken: number): string {
  if (!taken) return "";
  return taken === 1
    ? " 1 was left as it was: the file found for it is already in the catalog as another photograph with work of its own (ratings, flags, keywords, collections, a link or edits, or it is hidden or in the trash)."
    : ` ${taken} were left as they were: the files found for them are already in the catalog as other photographs with work of their own (ratings, flags, keywords, collections, a link or edits, or they are hidden or in the trash).`;
}

/** What a folder relink says about names it found more than once under
 * the folder: taking one of them could put the wrong photograph under
 * the right name, so none is taken. */
export function ambiguousNote(n: number): string {
  if (!n) return "";
  return n === 1
    ? " 1 was left as it was: more than one file under that folder has its name."
    : ` ${n} were left as they were: more than one file under that folder has each of their names.`;
}

/** Finds a moved photograph again, and everything that moved with it.
 *
 * The owner's design for this: relink "re-homes an image to its new
 * folder", collections being folder-agnostic. So the catalog row is
 * updated in place rather than replaced. Its id keys the saved graph,
 * the cached thumbnail, the keywords and every collection membership,
 * and a new row would be a stranger wearing the same picture.
 */
export async function relinkFrom(state: State, dispatch: D) {
  const missing = taggingTargets(state).filter(
    (i) => state.images.find((x) => x.id === i)?.missing,
  );
  const id = missing[0];
  if (!id) return;
  const name = state.images.find((i) => i.id === id)?.name ?? "the photograph";
  // Noted once the file or folder is picked, before the relink runs: a
  // folder clicked while it runs is newer, and the re-read below must
  // not take the library back to the folder from before it.
  let nav = currentNavigation();
  try {
    let report: { relinked: number; stillMissing: number; taken: number; ambiguous?: number };
    let told: string;
    if (missing.length > 1) {
      // A multi-selection relinks at the FOLDER level ("I just
      // have to repoint to the root folder"): each missing photograph is
      // found by name under the picked root, subfolders included.
      const root = await pickRelinkFolder();
      if (!root) return;
      nav = currentNavigation();
      let stopped: string | null = null;
      try {
        report = await watchOp("relink", () => relinkFolder(missing, root));
      } catch (e) {
        // A cancel between files keeps the relinks that landed, and
        // the error says how far it got; the strip has to learn about
        // them the same way a whole run does, so the re-read below
        // still happens.
        stopped = String(e);
        report = { relinked: 0, stillMissing: 0, taken: 0 };
      }
      const left = report.stillMissing
        ? ` ${report.stillMissing} of them ${report.stillMissing === 1 ? "was" : "were"} not under that folder.`
        : "";
      told = stopped ? `Relinking stopped: ${stopped}` : `Relinked ${report.relinked} of ${missing.length} selected.${left}${ambiguousNote(report.ambiguous ?? 0)}${takenNote(report.taken)}`;
    } else {
      const target = await pickRelinkTarget(id);
      if (!target) return;
      nav = currentNavigation();
      report = await relinkImage(id, target);
      const swept = report.relinked > 1 ? ` and ${report.relinked - 1} more that moved with it` : "";
      const left = report.stillMissing
        ? ` ${report.stillMissing} in that folder are still missing.`
        : "";
      told = `Relinked ${name}${swept}.${left}${takenNote(report.taken)}`;
    }
    logMsg("info", told);
    // Re-read the folder that is open rather than patching the ribbon. A
    // relinked photograph has moved OUT of this folder and has to leave
    // the strip, but relinking can also be a rename in place, in which
    // case it stays and merely stops being missing. The owner expected the
    // first: "I expected it to disappear from the current folder and I
    // would just have to switch folders to where it lives now." Re-reading
    // gets both right without the frontend having to guess which one
    // happened.
    if (state.activeFolderPath && !navStale(nav)) {
      await openFolderPlain(state.activeFolderPath, state.folderTree, dispatch, state.prefs.thumbnailEdge);
    } else {
      await refreshLibrary(dispatch);
    }
  } catch (e) {
    logMsg("error", `Could not relink ${name}: ${String(e)}`);
    flashStatus(`Could not relink ${name}: ${String(e).replace(/^Error: /, "")}`);
  }
}

/** Move to Trash: the photograph leaves the folder, not the disk.
 *
 * Asks once, like hiding, and for the same reason: the file is renamed
 * into a `.trash` beside it and Put Back is the rename going the other
 * way. The second prompt belongs to actions with nothing behind them,
 * and there is no longer an action in this app like that.
 */
export function askTrash(state: State, dispatch: D) {
  const action = trashConfirmAction(state);
  if (action) dispatch({ type: "ask_confirm", action });
}

/** Forget Missing Trashed Photos: asks the disk which trashed
 * photographs no longer have a file in `.trash`, then raises the one
 * confirmation that lists them. Nothing found (put back, or the drive
 * went away, since the last look) says so and grays the item. */
export async function askForgetMissingTrashed(dispatch: D): Promise<void> {
  try {
    const m = await missingTrashedPhotos();
    dispatch({ type: "set_missing_trashed", count: m.ids.length, skipped: m.skipped });
    if (!m.ids.length) {
      logMsg("info", "Every trashed photograph still has its file in .trash: nothing to forget.");
      return;
    }
    dispatch({
      type: "ask_confirm",
      action: { kind: "forget_missing_trashed", ids: m.ids, paths: m.paths, skipped: m.skipped, skippedVolumes: m.skipped_volumes },
    });
  } catch (e) {
    logMsg("error", `Could not look for missing trashed photographs: ${String(e)}`);
  }
}

/** Scrolls the ribbon to the photo on screen and pulses it.
 * "add an option in the Photo menu to find the currently selected
 * photo in the thumbnail view. Helpful when I scroll away and then
 * have a hard time finding it again."
 *
 * Two things this used to get wrong. It reopened the LIBRARY, which is
 * the folder and collection sidebar (BrowserPanelImpl, browserOpen), to
 * reveal a thumbnail that lives in the ribbon (RibbonImpl, ribbonOpen):
 * the wrong panel entirely. And it did so on every reveal, including the
 * automatic one that fires whenever the active photo changes, so
 * clicking any thumbnail with the library collapsed threw the sidebar
 * back open. "The library should only be expanded when that
 * sidebar is used, not from browsing photos in the current folder."
 *
 * So expanding is now opt-in and only ever opens the strip the thumbnail
 * is actually in. */
export function revealActiveThumb(
  state: State,
  dispatch: D,
  opts: {
    /** flash the outline. On by default: a person who asked to be
     * shown the photo wants their eye caught. Off when the app does the
     * scrolling on its own. */
    pulse?: boolean;
    behavior?: ScrollBehavior;
    /** skip the whole thing when the thumbnail is already on screen,
     * so restoring a session does not yank a list the user can see. */
    onlyIfOffscreen?: boolean;
    /** open a collapsed ribbon first. Only for an explicit "find it",
     * never for the app scrolling on its own behalf: a panel the user
     * collapsed stays collapsed until the user says otherwise. */
    expand?: boolean;
  } = {},
) {
  const {
    pulse = true,
    behavior = "smooth",
    onlyIfOffscreen = false,
    expand = false,
  } = opts;
  if (!state.activeImage) return;
  const opening = expand && !state.ribbonOpen;
  if (opening) dispatch({ type: "toggle_ribbon" });
  if (!expand && !state.ribbonOpen) return;
  window.setTimeout(
    () => {
      const el = document.querySelector<HTMLElement>(
        `[data-testid="thumb-${state.activeImage}"]`,
      );
      // The app scrolling on its own (a photo opened or restored) asks the
      // ribbon's strip, which measures in its own offsets and leaves a photo
      // already in view where it is: WebKit's client rects and
      // scrollIntoView miss inside the strip's CSS zoom, so a launch never
      // centered the photo. The expanded table scrolls its rows itself.
      const inStrip = !!el?.closest('[data-testid="ribbon-scroll"]');
      if (!el || (onlyIfOffscreen && inStrip)) { window.dispatchEvent(new Event("heeler:reveal-thumbnail")); return; }
      if (onlyIfOffscreen && thumbIsVisible(el)) return;
      el.scrollIntoView({ block: "center", behavior });
      // An instant programmatic scroll can leave WKWebView holding stale
      // paint for the strip: the thumbs were THERE (hit testing knew) but
      // nothing drew until a real wheel event invalidated the compositor.
      // "the ribbon goes blank until I scroll my mouse in it."
      // Nudging scrollTop through a genuine mutation on the next frame is
      // that wheel turn, one pixel down and back. Smooth scrolls are
      // exempt: assigning scrollTop would cancel the glide, and their
      // animation repaints every frame anyway.
      if (behavior === "auto") {
        const scroller = el.parentElement;
        requestAnimationFrame(() => {
          if (!scroller) return;
          scroller.scrollTop += 1;
          scroller.scrollTop -= 1;
        });
      }
      if (!pulse) return;
      el.classList.add("thumb-reveal");
      window.setTimeout(() => el.classList.remove("thumb-reveal"), 1700);
    },
    // A beat for the strip to exist when we just opened it.
    opening ? 80 : 0,
  );
}

/** Whether a thumbnail is fully inside the strip that scrolls it.
 *
 * Found by walking up to the first ancestor that actually scrolls,
 * rather than by reaching for a known class: the ribbon and the
 * expanded table are different boxes and both scroll their rows. */
export function thumbIsVisible(el: HTMLElement): boolean {
  let box: HTMLElement | null = el.parentElement;
  while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
  if (!box) return false;
  const a = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return a.top >= b.top && a.bottom <= b.bottom;
}

/** Arrow keys over the folder tree, the usual tree keys: Up and Down move
 * between the rows on screen, Right opens a row or steps into it, Left
 * closes it or steps out to its parent, Home and End go to the ends, and
 * Enter opens the folder. The keyboard had no way into the tree at all. */
export function treeKeys(e: React.KeyboardEvent<HTMLElement>): void {
  const tree = e.currentTarget;
  const rows = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const here = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
  if (!here || rows.length === 0) return;
  const at = rows.indexOf(here);
  const level = Number(here.getAttribute("aria-level"));
  const move = (row: HTMLElement | undefined) => {
    if (!row) return;
    for (const r of rows) r.tabIndex = r === row ? 0 : -1;
    row.focus();
    row.scrollIntoView?.({ block: "nearest" });
  };
  const toggle = () => here.querySelector<HTMLElement>('[data-testid^="tree-toggle-"]')?.click();
  switch (e.key) {
    case "ArrowDown":
      move(rows[at + 1]);
      break;
    case "ArrowUp":
      move(rows[at - 1]);
      break;
    case "Home":
      move(rows[0]);
      break;
    case "End":
      move(rows[rows.length - 1]);
      break;
    case "ArrowRight":
      if (here.getAttribute("aria-expanded") === "false") toggle();
      else if (here.getAttribute("aria-expanded") === "true" && Number(rows[at + 1]?.getAttribute("aria-level")) === level + 1) move(rows[at + 1]);
      break;
    case "ArrowLeft":
      if (here.getAttribute("aria-expanded") === "true") toggle();
      else move(rows.slice(0, at).reverse().find((r) => Number(r.getAttribute("aria-level")) === level - 1));
      break;
    case "Enter":
    case " ":
      here.querySelector<HTMLElement>('[data-testid^="tree-open-"]')?.click();
      break;
    default:
      return;
  }
  e.preventDefault();
}

/** Renames a folder, then the tree and the library follow: its branch
 * takes the new name with its open folders kept, and if you were inside
 * it the folder you were in opens again under its new path. */
export async function renameFolderTo(path: string, name: string, state: State, dispatch: D): Promise<string | null> {
  try {
    const r = await renameFolder(path, name);
    const wasInside = state.activeFolderPath !== null && isWithin(state.activeFolderPath, path);
    dispatch({ type: "rename_tree_node", from: path, to: r.path, name: leafName(r.path) });
    if (wasInside && state.activeCollection === null) {
      const now = r.path + state.activeFolderPath!.slice(path.replace(/[\\/]+$/, "").length);
      await openFolderPlain(now, state.folderTree, dispatch, state.prefs.thumbnailEdge);
    }
    for (const p of r.problems) logMsg("warn", `Renamed, but this trash could not be updated: ${p}`);
    flashStatus(r.problems.length ? `Renamed to ${leafName(r.path)}, but ${r.problems.length} trash folder could not be updated; see the Console.` : `Renamed to ${leafName(r.path)}.`);
    void refreshLibrary(dispatch);
    return null;
  } catch (e) {
    return String(e).replace(/^Error: /, "");
  }
}
