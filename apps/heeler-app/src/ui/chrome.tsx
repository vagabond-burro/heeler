import { ThumbnailStrip } from "./thumbnailstrip";
import { MenuSurface } from "./menusurface";
// App chrome: top bar, far-left tab rail, browser panel, thumbnail ribbon.
// Library, Develop and Graph share the same layout and spacing values.

import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { panePropsEqual } from "./viewmemo";
import { createPortal } from "react-dom";
import type { Command, ImageEntry, Mode, State, TreeNode } from "../state";
import { exportDpi, photoFlipBlocked, photoFlips, layerMaskToggleTarget } from "../state";
import { ART_CONTENT_KINDS, ART_KINDS, CROP_RATIOS, DOC_SEL_ID, cropRatioList, LAYER_MASK_TYPES, SELECT_METHODS, availableMaskTypes, activeSelectionMask, ancestorsBetween, bakeable, filtersActive, folderHasEdits, isPano, isStack, parseAspect, selectionHasContent, selectionLoadSource, stackAppendTargets, taggingTargets, thumbCell, visibleImages, duplicable } from "../state";
import { layerActionHint, layerActions, maskToggleItem } from "../layeractions";
import { bakeMaskRaster, entryFromRow } from "../bridge";
import { reportToolError } from "./hints";
import { catalogSaves } from "../savebarrier";
import { watchOp } from "./opprogress";
import { publishBusy } from "./statusbar";
import { removeObjectSource, runCommand } from "../commands";
import { MergedIcon, RIBBON_ICON_CHIP, RibbonControls, RibbonExpandButton } from "./ribbontable";
import { CatalogView } from "./catalogview";
import { FlagToggle, PickMark, StarRow } from "./tagrow";
import { copyEditsFrom, pasteEditsTo } from "../copyedits";
import { openQuadEdit } from "../quadedit";
import { linkHint, linkPhotos, unlinkPhotos } from "../links";
import { LinkIcon } from "./linkicon";
import { quickExport } from "../export";
import { TrackSlider, ValueField } from "./track";
import exportResolution from "../../../../crates/heeler-io/export-resolution.json";
import { DateRangeFields, ShotDateRunner } from "./datefields";
import { TakeRangeFields } from "./takefields";
import { clampMenu, viewportSize } from "./menupos";
export { CROP_RATIOS, parseAspect };
import { PHOTO } from "../data";
import { LEGAL_MENU_LABEL, OPEN_SOURCE_MENU_PATH } from "../legaldocs";
import {
  addToCollection, createCollection, deleteCollection, editedFolders, exportTo, isTauri,
  exportImage, lastSessionFolder, listCollections, listFolders, listSubfolders, loadCollection, loadFolderSession, loadGraph, loadSession, loadThumbnail, openFolder, pickExportFolder, writeGallery,
  STACK_KINDS, createStack, createPano, persistFlag, persistRating, removeFromCollection, renameCollection, revealFolder, saveSession, stackAppend,
  serializeGraph, serializeLoadedGraph, serveCacheDir, serveFileName, serveStart, serveStatus, serveStop,
  filePassesAt, pickImageFile,
  type FolderImage, type FolderListing, type ServeStatus,
} from "../bridge";
import { UPDATE_DOWNLOAD_WORDS, checkForUpdates } from "../updates";
import { allKeywords, buildInfo, clearRecentCatalogs, folderSubtreeCounts, foldersWithHidden, foldersWithTrash, forgetRecentCatalog, missingTrashedPhotos, recentCatalogs, revealTrash, hiddenInFolder, type RecentCatalog, imageKeywords, imagesWithKeyword, pickRelinkFolder, pickRelinkTarget, relinkFolder, relinkImage, setImageKeywords } from "../bridge";
import { logMsg } from "../log";
import { beginThumbSession, thumbnailGraph } from "../thumbs";
import { ThumbBox } from "./thumbbox";
import { watchMaximizeButton } from "../snaplayouts";
import { bindingFor, formatBinding } from "../hotkeys";
import { TOOL_WINDOWS, rememberPopoutOpener, type ToolWindowKind } from "../popout";
import { CHROME_ZOOM_DEFAULT, CHROME_ZOOM_STEPS, applyChromeZoom, chromeZoomFactor, setUiPref, uiPref } from "../uiprefs";
import { centerMainWindow, toggleFullscreen } from "../windowops";
import { menuTree } from "../nodes";
import { addNodeAt } from "./addnode";
import { polishEnabled } from "../features";
import { flashStatus } from "./hints";
import { isMac, isMacControlClick, modLabel } from "../platform";

type D = React.Dispatch<Command>;

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
  const [folders, collections, edited, hidden, trash, missing] = await Promise.all([
    listFolders(),
    listCollections(),
    editedFolders(),
    foldersWithHidden(),
    foldersWithTrash(),
    // A failed look leaves the menu item grayed rather than the library
    // unrefreshed.
    missingTrashedPhotos().catch(() => ({ ids: [], paths: [], skipped: 0, skipped_volumes: [] })),
  ]);
  dispatch({ type: "set_folders", folders });
  dispatch({ type: "set_collections", collections });
  dispatch({ type: "set_edited_folders", paths: edited });
  dispatch({ type: "set_folders_with_hidden", paths: hidden });
  dispatch({ type: "set_folders_with_trash", paths: trash });
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
  for (const id of ids) {
    const name = state.images.find((i) => i.id === id)?.name;
    if (op === "add") await addToCollection(col!.id, id, name);
    else if (op === "remove") await removeFromCollection(col!.id, id);
    else for (const c of state.collections) await removeFromCollection(c.id, id);
  }
  // Viewing a collection that just shrank: reload it, so the ribbon
  // tells the truth instead of showing ghosts.
  if (op !== "add" && col) {
    const files = await loadCollection(col.id);
    loadSessionImages(files, dispatch, state.prefs.thumbnailEdge);
    dispatch({ type: "set_library", label: col.name, collection: col.id, path: null });
  }
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

/** Small pencil badge for folders that hold edited images. */
function EditedBadge({ path }: { path: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2"
      data-testid={`folder-edited-${path}`}
      style={{ flex: "none" }}
    >
      <path d="M17 3l4 4L8 20l-5 1 1-5z" />
    </svg>
  );
}

/** Small bin badge for folders with a `.trash` beside them.
 *
 * The passive half of the discovery story. A trash nobody can see is a
 * trash nobody empties, and a folder of full-size RAW files quietly
 * eating a disk is the thing people are furious about six months later.
 * Exact match rather than prefix, unlike the edited badge: the `.trash`
 * is in THIS folder, and marking every ancestor would say four things
 * where one is true.
 */
function TrashBadge({ path }: { path: string }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      // Takes the row's color rather than one of its own, so it goes accent
      // with the name when the folder is the one you are in
      // ("make the selected folder font (and trash icon) color the accent").
      // A marker that stayed gray on a lit row read as belonging to some
      // other folder.
      stroke="currentColor"
      strokeWidth="2"
      data-testid={`folder-trash-${path}`}
      style={{ flex: "none" }}
    >
      <path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14" />
    </svg>
  );
}

function treeContains(node: TreeNode | null, path: string): boolean {
  if (!node) return false;
  if (node.path === path) return true;
  return (node.children ?? []).some((c) => treeContains(c, path));
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
  const inTree = treeContains(tree, listing.path);
  if (inTree) {
    dispatch({ type: "set_tree_node", path: listing.path, children: listing.subfolders, expanded: true });
  } else {
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

const leafName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() ?? p;

/** Monotonic navigation token. Every folder pick, tree click, collection
 * view, or catalog restore takes a fresh one, and slower work in flight
 * checks it after each await: clicking around quickly must never end
 * with an older click's listing landing on top of the newer one. */
let navToken = 0;
export function beginNavigation(): number {
  return ++navToken;
}
const navStale = (token: number) => token !== navToken;

/** Expands the tree from `root` down to `folder`, opens it, and puts its
 * images in the ribbon. The tree nodes are dispatched directly rather
 * than through applyFolderListing: every path here is already known to be
 * inside the tree, so nothing needs the committed tree to decide. */
async function descendTo(
  root: string,
  folder: string,
  dispatch: D,
  nav: number,
  thumbnailEdge: number,
): Promise<FolderListing | null> {
  for (const ancestor of ancestorsBetween(root, folder)) {
    const children = await listSubfolders(ancestor).catch(() => []);
    if (navStale(nav)) return null;
    dispatch({ type: "set_tree_node", path: ancestor, children, expanded: true });
  }
  const listing = await openFolder(folder).catch(() => null);
  if (navStale(nav) || !listing || !listing.path) return null;
  dispatch({ type: "set_tree_node", path: listing.path, children: listing.subfolders, expanded: true });
  loadSessionImages(listing.images, dispatch, thumbnailEdge);
  dispatch({ type: "set_library", label: listing.name, collection: null, path: listing.path });
  catalogSaves.arm("session", 600, () => saveSession(root, listing.path));
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
  const listing = await openFolder(path);
  if (navStale(nav) || !listing || !listing.path) return;
  applyFolderListing(listing, tree, dispatch, thumbnailEdge);
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
  const listing = await openFolder(path);
  if (navStale(nav) || !listing || !listing.path) return;
  // Where did work in this folder stop? Asked BEFORE the listing is
  // applied: applying saves the session, and that save must never be
  // allowed to overwrite the very record being restored from. (Reading
  // it after is how re-picking a folder erased its own memory and left
  // the ribbon empty.)
  const sess = await loadFolderSession(listing.path).catch(() => null);
  if (navStale(nav)) return;
  applyFolderListing(listing, tree, dispatch, thumbnailEdge);
  void refreshLibrary(dispatch);
  if (!sess) return;
  let images = listing.images;
  if (sess.activeFolder !== listing.path) {
    const sub = await descendTo(listing.path, sess.activeFolder, dispatch, nav, thumbnailEdge);
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

/** How each mask type decides what it covers. Keyed to
 * LAYER_MASK_TYPES, so a new one arriving without a line here is a
 * compile error rather than a silent blank in the status row. */
const MASK_TYPE_HINTS: Record<(typeof LAYER_MASK_TYPES)[number], string> = {
  range: "The adjustment lands only on tones or colors you pick out of the photograph.",
  radial: "The adjustment lands inside an oval you place and soften: a face, a light, a corner.",
  linear: "The adjustment fades across the frame along a line you draw: skies, foregrounds.",
  brush: "The adjustment lands where you paint it, and nowhere else.",
  selection: "The adjustment lands inside the selection you have drawn.",
  smart: "The adjustment lands on what the model finds where you point: a sky, a person, an object.",
  object: "The adjustment lands on objects the render named in the file itself, exact to the pixel: an OpenEXR with Cryptomatte.",
};

/** The three workspaces, each with a glyph (icons rather
 * than the words on the tabs): sliders for Develop, two cards on a
 * wire for Graph, a brush over a board for Canvas. The word stays as
 * the accessible name and in the status bar.*/
const MODES: { id: Mode; label: string; icon: string }[] = [
  { id: "simple", label: "Develop", icon: "M4 7h10M18 7h2M4 12h4M12 12h8M4 17h12M20 17h0M14 5v4M8 10v4M16 15v4" },
  // Three cards, two feeding one, with the wires drawn: the first
  // draft's two small boxes read as dots.
  { id: "advanced", label: "Graph", icon: "M1 3h8v6H1zM1 15h8v6H1zM15 9h8v6h-8zM9 6c3 0 3 6 6 6M9 18c3 0 3-6 6-6" },
  { id: "canvas", label: "Canvas", icon: "M4 4h16v12H4zM8 20h8M12 16v4M15 7l-5 5" },
];

import { GroupGlyph } from "./editors";
import { useDismiss } from "./hooks";
import { PanelDivider } from "./divider";
import { useTopBarFit } from "./layoutroom";
import { ADJUST_SEAT, CONTENT_ITEMS, IMAGE_ITEMS, IMAGE_SEAT, UTILITY_ITEMS, addContentLayer, adjustmentItems } from "./finishnew";
import { SuggestField } from "./suggestfield";
export { GroupGlyph };

function Star({ on }: { on: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill={on ? "var(--accent)" : "none"} stroke={on ? "none" : "#575c62"} strokeWidth="1.6">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" />
    </svg>
  );
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

/** The key beside a menu entry. Nothing at all when the command is
 * unbound, rather than an empty box: a menu full of blank chips reads as
 * something failing to load. */
/** The item's hotkey, at the label's own size and one step dimmer
 * than it (2026-09-09: at 9px in ghost gray they were "really
 * hard to read").*/
function MenuKey({ binding }: { binding: string }) {
  if (!binding) return null;
  return (
    <span
      className="tnum"
      data-testid="menu-key"
      style={{
        fontSize: "inherit",
        fontFamily: "ui-monospace, monospace",
        color: "var(--text-dim)",
        letterSpacing: ".02em",
      }}
    >
      {formatBinding(binding)}
    </span>
  );
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

function namesOf(state: State, ids: string[]): string[] {
  return ids.map((id) => state.images.find((i) => i.id === id)?.name ?? id);
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
  try {
    let report: { relinked: number; stillMissing: number };
    let told: string;
    if (missing.length > 1) {
      // A multi-selection relinks at the FOLDER level ("I just
      // have to repoint to the root folder"): each missing photograph is
      // found by name under the picked root, subfolders included.
      const root = await pickRelinkFolder();
      if (!root) return;
      let stopped: string | null = null;
      try {
        report = await watchOp("relink", () => relinkFolder(missing, root));
      } catch (e) {
        // A cancel between files keeps the relinks that landed, and
        // the error says how far it got; the strip has to learn about
        // them the same way a whole run does, so the re-read below
        // still happens.
        stopped = String(e);
        report = { relinked: 0, stillMissing: 0 };
      }
      const left = report.stillMissing
        ? ` ${report.stillMissing} of them ${report.stillMissing === 1 ? "was" : "were"} not under that folder.`
        : "";
      told = stopped ? `Relinking stopped: ${stopped}` : `Relinked ${report.relinked} of ${missing.length} selected.${left}`;
    } else {
      const target = await pickRelinkTarget(id);
      if (!target) return;
      report = await relinkImage(id, target);
      const swept = report.relinked > 1 ? ` and ${report.relinked - 1} more that moved with it` : "";
      const left = report.stillMissing
        ? ` ${report.stillMissing} in that folder are still missing.`
        : "";
      told = `Relinked ${name}${swept}.${left}`;
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
    if (state.activeFolderPath) {
      await openFolderPlain(state.activeFolderPath, state.folderTree, dispatch, state.prefs.thumbnailEdge);
    } else {
      await refreshLibrary(dispatch);
    }
  } catch (e) {
    logMsg("error", `Could not relink ${name}: ${String(e)}`);
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
  const ids = taggingTargets(state);
  if (!ids.length) return;
  dispatch({ type: "ask_confirm", action: { kind: "trash_images", ids, names: namesOf(state, ids) } });
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

/** A menu entry that opens a nested list beside it. Kept in the menu
 * rather than promoted to its own top-level item: stacking is one family
 * of things you do to a photo, and panorama will join it. */
function SubMenu({
  label,
  testid,
  disabled,
  hint,
  why,
  scroll = true,
  children,
}: {
  label: string;
  testid: string;
  disabled?: boolean;
  /** Off for a list whose rows open lists of their own (MenuSurface). */
  scroll?: boolean;
  /** What the fold-out is for, and where it applies while it is off.
   * On the wrapper rather than the button, for the same reason every
   * other menu row puts it there: a disabled button fires no mouse
   * events, so a hint written on it is unreadable exactly when it is
   * most needed. */
  hint?: string;
  why?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ position: "relative" }}
      data-hint={hint && disabled && why ? `${hint} ${why}` : hint}
      onMouseEnter={() => !disabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={e => {
        if (e.key === "ArrowRight" && e.target === e.currentTarget.firstElementChild && !disabled) {
          e.preventDefault(); e.stopPropagation(); setOpen(true);
        } else if (open && (e.key === "ArrowLeft" || e.key === "Escape")) {
          e.preventDefault(); e.stopPropagation(); setOpen(false);
        }
      }}
    >
      <button
        aria-haspopup="menu" aria-expanded={open}
        data-testid={testid}
        disabled={disabled}
        data-active={open}
        onClick={() => !disabled && setOpen(!open)}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}
      >
        {label}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M9 6l6 6-6 6" />
        </svg>
      </button>
      {open && (
        <MenuSurface submenu scroll={scroll} aria-label="Commands" className="ctx-menu" style={{ position: "absolute", left: "100%", top: -4 }} data-testid={`${testid}-list`}>
          {children}
        </MenuSurface>
      )}
    </div>
  );
}

/** Types a ratio the list does not offer. Lives in the menu rather than
 * a dialog, because reaching for 5:7 is a one-off and a dialog for it
 * would be three clicks to type four characters. */
function CustomAspect({ dispatch }: { dispatch: D }) {
  const [text, setText] = useState("");
  const parsed = parseAspect(text);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 9px" }}>
      <input
        data-testid="menu-photo-aspect-custom"
        placeholder="5:4"
        value={text}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && parsed !== null) {
            dispatch({ type: "set_tool", tool: "crop" });
            dispatch({ type: "set_crop_aspect", aspect: parsed });
            setText("");
          }
        }}
        style={{
          width: 62, background: "var(--bg-app)", border: "1px solid var(--line-4)",
          color: "var(--text-body)", fontSize: 10, padding: "1px 4px", outline: "none",
        }}
      />
      <span
        style={{ fontSize: 9, color: parsed === null && text ? "var(--reject)" : "var(--text-ghost)" }}
      >
        {text === "" ? "custom" : parsed === null ? "not a ratio" : parsed.toFixed(3)}
      </span>
    </div>
  );
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
      if (!el) { window.dispatchEvent(new Event("heeler:reveal-thumbnail")); return; }
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
function thumbIsVisible(el: HTMLElement): boolean {
  let box: HTMLElement | null = el.parentElement;
  while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
  if (!box) return false;
  const a = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  return a.top >= b.top && a.bottom <= b.bottom;
}

/** A menu pinned to viewport coordinates, rendered outside whatever
 * layout it was declared in.
 *
 * The library and ribbon panels carry `ui-zoom` (CSS zoom 1.15), and
 * zoom rescales position:fixed descendants as well: a menu asked for
 * top:400 draws at 460, an error that grows the further down the
 * pointer was. "the context menu is like way off, like one
 * whole thumbnail below." A portal to the body leaves the zoom behind,
 * so the coordinates mean what they say.
 */
function FixedMenu({ children }: { children: React.ReactNode }) {
  if (typeof document === "undefined" || !document.body) return <>{children}</>;
  return createPortal(children, document.body);
}

export function MenuBar({ state, dispatch }: { state: State; dispatch: D }) {
  const [open, setOpen] = useState<string | null>(null);
  const close = () => setOpen(null);
  // The recent catalogs, read when the File menu opens (2026-09-08: "a
  // Recent Catalogs in the file menu"). Read again on every open: a drive
  // plugged in since the last look changes availability. Keep the previous
  // names visible while reading, but clear their old marks.
  const [recent, setRecent] = useState<RecentCatalog[]>([]);
  const [recentPending, setRecentPending] = useState(false);
  const recentGeneration = useRef(0);
  const recentMutation = useRef(false);
  const [recentChanging, setRecentChanging] = useState(false);
  const [recentRefresh, setRecentRefresh] = useState(0);
  const changeRecent = async (job: () => Promise<RecentCatalog[]>) => {
    if (recentMutation.current) return;
    recentMutation.current = true;
    setRecentChanging(true);
    ++recentGeneration.current;
    try {
      const rows = await job();
      setRecent(previous => rows.slice(0, 10).map(row => previous.find(p => p.path === row.path) ?? row));
    } catch (e) { flashStatus(String(e), 8000); }
    finally {
      recentMutation.current = false;
      setRecentChanging(false);
      setRecentRefresh(n => n + 1);
    }
  };
  // Right-click on one remembered catalog: the only thing to do to a
  // list entry is take it off the list, so the menu holds one item
  // (2026-09-12). It forgets a path and never a file.
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number; path: string; name: string } | null>(null);
  const recentMenuRef = useDismiss<HTMLDivElement>(recentMenu !== null, () => setRecentMenu(null));
  useEffect(() => {
    if (open !== "file") return;
    const generation = ++recentGeneration.current;
    const live = () => generation === recentGeneration.current;
    setRecentPending(true);
    setRecent(rows => rows.map(r => ({ ...r, exists: null, active: null })));
    void recentCatalogs().then(rows => {
      if (!live()) return;
      setRecent(rows.map(r => ({ ...r, exists: null, active: null })));
      return recentCatalogs(true).then(checked => { if (live()) setRecent(checked); });
    }).catch(() => {}).finally(() => { if (live()) setRecentPending(false); });
    return () => { ++recentGeneration.current; };
  }, [open, recentRefresh]);
  const rootRef = useDismiss<HTMLDivElement>(open !== null, close);
  // A menu entry, with the key that does the same thing beside it. The
  // binding is read from the registry rather than typed into the label,
  // so rebinding a command updates the menu instead of leaving it
  // advertising a key that no longer works.
  // The hint goes on a WRAPPER, never on the button.
  //
  // A disabled button fires no mouse events, so a data-hint written on
  // it is exactly the hint nobody can read, and the grayed item is the
  // one that most needs to explain itself. "When a menu
  // item is disabled, we could update the tool tip to inform the user
  // on the context it is enabled so there is direction, guidance. Not
  // just a 'sorry, bro. can't use this'." The mouseover lands on this
  // div instead; an enabled item finds it by walking up, which is what
  // useHintSource's closest does anyway.
  /** Why Photo > Flip is grayed, as a sentence. */
  const flipWhy = (s: State): string | undefined => {
    const why = photoFlipBlocked(s);
    return why ? `${why.charAt(0).toUpperCase()}${why.slice(1)}.` : undefined;
  };
  const item = (
    label: string,
    action: () => void,
    testid: string,
    disabled = false,
    cmd?: string,
    /** What it does, in outcome words. */
    hint?: string,
    /** Where it DOES apply, added after the hint while it is grayed.
     * Same shape as the layer list's, so the two menus that share this
     * bar cannot explain themselves in two different voices. */
    why?: string,
    /** A gesture in words where a key would show, for an item reached
     * by a modified click rather than a key (Disable Layer Mask). */
    keys?: string,
  ) => (
    <div key={testid} data-hint={hint && disabled && why ? `${hint} ${why}` : hint}>
      <button
        data-testid={testid}
        disabled={disabled}
        onClick={() => {
          action();
          close();
        }}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, width: "100%" }}
      >
        <span>{label}</span>
        {cmd && <MenuKey binding={bindingFor(cmd, state.prefs.hotkeys)} />}
        {keys && (
          <span data-testid="menu-keys" style={{ color: "var(--text-dim)" }}>
            {keys}
          </span>
        )}
      </button>
    </div>
  );
  /** A menu entry that is a switch over anything: a tick when it is
   * on, the action flips it. The Dev menu's own checkmark rows, made
   * reusable for the Window menu. */
  const check = (
    label: string,
    checked: boolean,
    action: () => void,
    testid: string,
    hint: string,
    cmd?: string,
    disabled = false,
    why?: string,
  ) => (
    <div key={testid} data-hint={hint && disabled && why ? `${hint} ${why}` : hint}>
      <button
        data-testid={testid}
        role="menuitemcheckbox"
        aria-checked={checked}
        data-checked={checked || undefined}
        disabled={disabled}
        onClick={() => {
          action();
          close();
        }}
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18, width: "100%" }}
      >
        <span>{label}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {cmd && <MenuKey binding={bindingFor(cmd, state.prefs.hotkeys)} />}
          <span style={{ width: 10, color: "var(--accent)" }}>{checked ? "✓" : ""}</span>
        </span>
      </button>
    </div>
  );
  const consoleLive = state.consoleWindowOpen;
  const chromeZoom = uiPref("chromeZoom", CHROME_ZOOM_DEFAULT);
  /** A menu entry that is a switch: a tick when it is on. */
  const toggle = (
    label: string,
    key: "selectFromCenter" | "selectAntialias" | "selectAutoClear" | "selectShowClicks",
    testid: string,
    hint?: string,
  ) => (
    <div key={testid} data-hint={hint}>
    <button
      data-testid={testid}
      aria-checked={state[key]}
      data-checked={state[key] || undefined}
      onClick={() => {
        dispatch({ type: "set_ui_setting", key, value: !state[key] });
        close();
      }}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}
    >
      <span>{label}</span>
      <span style={{ width: 10, color: "var(--accent)" }}>{state[key] ? "✓" : ""}</span>
    </button>
    </div>
  );

  const menus: { id: string; label: string; items: React.ReactNode[] }[] = [
    {
      id: "file",
      label: "File",
      items: [
        item(
          "Open folder…",
          () => {
            void openFolderRemembering(undefined, state.folderTree, dispatch, state.prefs.thumbnailEdge);
          },
          "menu-file-open",
          false,
          "file.open",
          "Open a folder of photographs and work in it. The folder joins the catalog and the files stay where they are.",
        ),
        <div key="s1" className="sep" />,
        // A catalog is the user's own file. Everything here creates,
        // opens, copies or merges one; nothing here deletes one, which
        // is the file browser's job and their decision.
        item(
          "Catalogs and recovery…",
          () => dispatch({ type: "open_catalogs" }),
          "menu-file-catalogs",
          false,
          "catalog.manage",
          "Make, open, copy or merge a catalog database. Recovery bundle also preserves the graph files and takes.",
        ),
        // A fold-out, like Rating (2026-09-08: "should be a sub menu"): the
        // catalogs this computer has had open, most recent first, the one in
        // use ticked and a missing one grayed. The desktop decides how many it
        // keeps (ten), so nothing here trims the list a second time with a
        // number of its own.
        <SubMenu
          key="recent"
          label="Recent Catalogs"
          testid="menu-file-recent"
          hint="Switch to a catalog this computer has had open before. Right-click one to take it off the list."
        >
          {recent.length === 0
            ? item(
                recentPending ? "Reading recent catalogs…" : "No recent catalogs",
                () => {},
                "menu-file-recent-none",
                true,
                undefined,
                "Catalogs you open appear here, most recent first.",
                "",
              )
            : recent.map((r, i) => {
                const folder = r.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? "";
                return (
                  <div
                    key={r.path}
                    role="group"
                    tabIndex={r.exists === false || r.active === true ? 0 : undefined}
                    // The shortcut is in the name because that is how
                    // this app tells people what they can do, and
                    // aria-keyshortcuts support is uneven. The attribute
                    // rides along for the readers that do honor it.
                    aria-label={`${r.name}: Shift+F10 for list actions`}
                    aria-keyshortcuts="Shift+F10"
                    onKeyDown={(e) => {
                      if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const box = e.currentTarget.getBoundingClientRect();
                      setRecentMenu({ x: box.left, y: box.bottom, path: r.path, name: r.name });
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRecentMenu({ x: e.clientX, y: e.clientY, path: r.path, name: r.name });
                    }}
                  >
                  {item(
                  `${r.active ? "✓ " : ""}${r.name}${folder ? `  (${folder})` : ""}`,
                  () => {
                    void import("./catalogui").then(({ switchCatalog }) =>
                      switchCatalog(r.path, dispatch, state.prefs.thumbnailEdge).then((said) => said && flashStatus(said, 8000)),
                    );
                  },
                  `menu-file-recent-${i}`,
                  r.exists === false || r.active === true,
                  undefined,
                  // An availability check that has not answered yet says
                  // so in the hint, not in the label: a menu row is a
                  // name, and a parenthetical about disk state after the
                  // folder name is not what a reader is scanning for.
                  r.active
                    ? "The catalog in use."
                    : !recentPending && r.exists === null
                      ? `Switch to ${r.path}. Availability is unknown; reopen this menu to check again.`
                      : `Switch to ${r.path}.`,
                  r.exists === false ? `${r.path} is not there right now; plug the drive in or put the file back.` : "",
                  )}
                  </div>
                );
              })}
          {recent.length > 0 && <div key="recent-sep" className="sep" />}
          {recent.length > 0 &&
            item(
              "Clear list",
              () => { void changeRecent(clearRecentCatalogs); },
              "menu-file-recent-clear",
              recentChanging,
              undefined,
              "Empty this list. It forgets where the catalogs were and removes no file; the one in use stays open.",
              "Wait for the current list change to finish.",
            )}
        </SubMenu>,
        <div key="s1b" className="sep" />,
        item(
          "Preferences…",
          () => dispatch({ type: "open_prefs" }),
          "menu-file-prefs",
          false,
          "app.preferences",
          "Settings for the whole app: preview quality, cache sizes, color, tethering and keyboard shortcuts.",
        ),
        <div key="s2" className="sep" />,
        item(
          "Exit",
          () => {
            void (async () => {
              if (!isTauri()) return;
              const { getCurrentWindow } = await import("@tauri-apps/api/window");
              await getCurrentWindow().close();
            })();
          },
          "menu-file-exit",
          false,
          undefined,
          "Close Heeler. Your edits are already on disk: they are saved as you make them.",
        ),
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        item(
          "Undo",
          () => dispatch({ type: "undo" }),
          "menu-edit-undo",
          state.undoStack.length === 0,
          "edit.undo",
          "Step back one edit.",
          "Nothing to undo: this photograph is as you found it.",
        ),
        item(
          "Redo",
          () => dispatch({ type: "redo" }),
          "menu-edit-redo",
          state.redoStack.length === 0,
          "edit.redo",
          "Step forward again through an edit you undid.",
          "Nothing to redo: undo something first.",
        ),
        <div key="s1d" className="sep" />,
        // The graph's own Cmd+D, here so the key can be found at all.
        // 2026-10-01: "We need a hotkey to duplicate selected nodes. That is
        // pretty common in node editors" - it had been bound all along, and
        // nothing on screen said so.
        (() => {
          const inGraph = state.mode === "advanced" || state.mode === "canvas";
          const any = state.selection.length > 0;
          const ok = inGraph && state.selection.some(duplicable);
          return item(
            "Duplicate Nodes",
            () => runCommand("edit.duplicate", state, dispatch),
            "menu-edit-duplicate",
            !ok,
            "edit.duplicate",
            "Copy the selected nodes beside them, wires and all; the copies become the selection.",
            !inGraph
              ? "Works in the Graph and Canvas workspaces, on the nodes selected there."
              : !any
                ? "Select one or more nodes in the graph first."
                : "Output, the photograph, layer cards and Finish cannot be copied.",
          );
        })(),
        <div key="s1" className="sep" />,
        item(
          "Reset all edits",
          () => {
            // The whole selection when there is one; the drain in
            // app.tsx handles the on-disk side for each.
            for (const id of taggingTargets(state)) {
              dispatch({ type: "reset_image_edits", id });
            }
          },
          "menu-edit-reset",
          false,
          "edit.reset",
          "Put this photograph back to how it came off the card. The file itself is never touched, and Undo brings the edits back.",
        ),
        // Move to Trash is the one way a photograph leaves the library, and it
        // is here as well as on the thumbnail's right-click. The owner expects
        // it in both. Hiding used to sit beside it and is gone altogether: two
        // commands that both mean "stop showing me this" is one more than
        // anybody needs, and the one that leaves the file where it is was the
        // weaker of the two.
        <div key="s2e" className="sep" />,
        item(
          "Move to Trash…",
          () => askTrash(state, dispatch),
          "menu-edit-trash",
          !taggingTargets(state).length,
          "image.trash",
          "Move the selected photographs into a .trash folder beside them. Heeler never empties it.",
          "Select a photograph in the thumbnails first.",
        ),
        // Its one seat, beside Move to Trash (2026-10-01: "yes, build the
        // purge"): trashed photographs whose file was removed from .trash
        // outside Heeler leave the catalog. No file is touched.
        item(
          "Forget Missing Trashed Photos…",
          () => void askForgetMissingTrashed(dispatch),
          "menu-edit-forget-missing-trashed",
          state.missingTrashed.count === 0,
          undefined,
          "Forget trashed photographs whose file left .trash, edits and all. No file is touched.",
          state.missingTrashed.skipped > 0
            ? `None to forget; ${state.missingTrashed.skipped} on unplugged drives were not checked.`
            : "None to forget: each trashed photo still has its file.",
        ),
      ],
    },
    {
      id: "select",
      label: "Select",
      // Its own menu now rather than a corner of Edit. The owner asked for
      // the three to move here and for seven more beside them, and eleven
      // selection commands buried in Edit would be a menu you scroll.
      //
      // Every item is grayed with no selection to act on rather than
      // silently doing nothing, so the menu says whether the command is
      // available before you spend a click finding out.
      items: (() => {
        const has = !!activeSelectionMask(state);
        const go = (cmd: string) => () => runCommand(cmd, state, dispatch);
        // Most of this menu is off for one reason, so it is written once.
        // A grayed item should "inform the user on the
        // context it is enabled so there is direction, guidance."
        const NEED = "Draw a selection first, with a tool from Interactive Selection above.";
        const FINISH = "Switch to the FINISH tab, where the layer stack lives.";
        return [
          // The ways of MAKING a selection come first, in three submenus
          // (2026-09-10): draw it yourself, ask a model, or build it from the
          // picture. Then what you can do to a selection that exists.
          //
          // Interactive is where the tool and its cursor come from:
          // picking one arms the select tool with that method, exactly
          // what the Finish toolbar's long-press menu does.
          <SubMenu
            key="interactive"
            label="Interactive Selection"
            testid="menu-select-interactive"
            hint="Draw the selection yourself: marquee, lasso, pen and the rest; the pick arms the select tool and its cursor."
          >
            {SELECT_METHODS.filter((m) => m.id !== "smart").map((m) =>
              item(
                m.label,
                () => {
                  dispatch({ type: "set_select_method", method: m.id });
                  dispatch({ type: "arm_document_selection" });
                },
                `menu-select-tool-${m.id}`,
                false,
                undefined,
                // Each method already describes itself for the toolbar
                // that shares this list; one wording, both doors.
                m.hint,
              ),
            )}
          </SubMenu>,
          // The smart tools ask a model rather than drawing geometry.
          // "Have a divider below the current selections and then have the 3
          // selection tools for Click, Subject, and Sky. These don't create
          // layers or anything, they just create selections only." Each arms the
          // select tool with the Smart click method; Subject and Sky also set the
          // one-shot mode and drop any old base, and the overlay computes from
          // there.
          <SubMenu
            key="smart"
            label="Smart Selection"
            testid="menu-select-smart"
            hint="Let a model make the selection: click what you mean, or take the subject or the sky in one shot."
          >
            {([
              ["click", "Click", `Select by clicking the photo: click what you mean and the model finds its edges; ${modLabel("alt")}-click carves away. A selection only, no layer made.`],
              ["subject", "Subject", "The model selects the subject in one shot. A selection only, no layer made."],
              ["sky", "Sky", "The model selects the sky in one shot. A selection only, no layer made."],
            ] as const).map(([id, label, hint]) =>
              item(
                label,
                () => {
                  dispatch({ type: "set_select_method", method: "smart" });
                  dispatch({ type: "arm_document_selection" });
                  dispatch({ type: "set_text_param", id: DOC_SEL_ID, param: "mode", value: id });
                  if (id !== "click") {
                    // A fresh pick recomputes. Clearing the base alone
                    // never managed it: after a successful compute the
                    // re-pick left the state byte-identical to the one
                    // a failed compute ends in, so the overlay's latch
                    // swallowed it and the pick had only destroyed the
                    // old base. The ask counter is
                    // the pick made visible - UI state, not a node
                    // param, so it never rides the graph, the session,
                    // or the undo stack, where rewinding it would have
                    // made undo fire a model compute.
                    dispatch({ type: "set_text_param", id: DOC_SEL_ID, param: "matte_id", value: "" });
                    dispatch({ type: "smart_select_ask" });
                  }
                },
                `menu-select-smart-${id}`,
                false,
                undefined,
                hint,
              ),
            )}
          </SubMenu>,
          // The four Select by doors are open with or without a selection
          // (2026-09-09): with none, one is started. Without arming anything
          // (2026-09-10): the range builds the selection and the ants show it,
          // but no tool or cursor changes hands. Labels drop the "Select by"
          // prefix; the submenu already says it.
          <SubMenu
            key="by"
            label="Select By"
            testid="menu-select-by"
            hint="Make the selection from the picture itself, by brightness, color, contrast or depth; no tool is armed."
          >
            {item(
              "Luma Range…",
              go("select.range.luma"),
              "menu-select-luma",
              !state.activeImage,
              "select.range.luma",
              "Select by brightness: choose a range and everything in it comes in; starts a selection if there is none.",
              "Open a photograph first.",
            )}
            {item(
              "Color Range…",
              go("select.range.color"),
              "menu-select-color",
              !state.activeImage,
              "select.range.color",
              "Select by color: choose a hue range and everything in it comes in; starts a selection if there is none.",
              "Open a photograph first.",
            )}
            {item(
              "Contrast…",
              go("select.range.contrast"),
              "menu-select-contrast",
              !state.activeImage,
              "select.range.contrast",
              "Select the busy parts of the frame, where detail changes fastest; starts a selection if there is none.",
              "Open a photograph first.",
            )}
            {/* Depth from the model, not the file: another editor only
                offers this on phone photos carrying embedded depth;
                Heeler computes it for any photograph. */}
            {item(
              "Depth Range…",
              go("select.range.depth"),
              "menu-select-depth",
              !state.activeImage,
              "select.range.depth",
              "Select by distance from the camera, worked out by the model, not read from the file; starts a selection if there is none.",
              "Open a photograph first.",
            )}
          </SubMenu>,
          <div key="s0" className="sep" />,
          item("Select All", go("select.all"), "menu-select-all", !has, "select.all", "Take in the whole frame, so what follows applies everywhere.", NEED),
          item("Deselect", go("select.none"), "menu-select-none", !has, "select.none", "Drop the selection, so edits land on the whole frame again.", NEED),
          item("Invert Selection", go("select.invert"), "menu-select-invert", !has, "select.invert", "Swap what is selected for what is not.", NEED),
          <div key="s1" className="sep" />,
          // Polish: three numbers the mask already carries.
          // Polish leads the polish group: it decides where the edge
          // IS, and the other three shape it once that is settled.
          // The gate opened with P4's Smart matte (see features.ts);
          // it stays in the code so the tool can be pulled with one
          // flip if real photographs disagree.
          ...(polishEnabled()
            ? [
                item(
                  "Polish Selection…",
                  go("select.polish"),
                  "menu-select-polish",
                  // Open with nothing selected too: a layer's Smart or
                  // Object mask is what it polishes then, and with
                  // nothing at all the status line says what to do.
                  !state.activeImage,
                  "select.polish",
                  "Snap the edge onto the real one: the selection, or with none, the active layer's Smart or Object mask, which Apply puts back.",
                  "Open a photograph first.",
                ),
              ]
            : []),
          item(
            "Smooth Selection…",
            go("select.smooth"),
            "menu-select-smooth",
            !has,
            "select.smooth",
            "Round the jitter and corners out of the selection's edge.",
            NEED,
          ),
          item(
            "Feather Selection…",
            go("select.feather"),
            "menu-select-feather",
            !has,
            "select.feather",
            "Fade the selection's edge over a distance you choose, so what follows blends in.",
            NEED,
          ),
          item(
            "Resize Selection…",
            go("select.resize"),
            "menu-select-resize",
            !has,
            "select.resize",
            "Grow or shrink the selection by a number of pixels, all the way round.",
            NEED,
          ),
          <div key="s2" className="sep" />,
          // The other direction from Selection to Layer: take what is
          // visible on a layer and make it the selection. Needs a layer
          // rather than a selection, since it is the thing that makes
          // one.
          item(
            "Select Layer Pixels",
            go("select.layer_pixels"),
            "menu-select-layer-pixels",
            !state.artActive || state.panelTab !== "layers",
            "select.layer_pixels",
            "Turn what is painted on the active layer into the document selection.",
            state.panelTab !== "layers" ? FINISH : "Select a layer in the FINISH panel first.",
          ),
          // The other other direction: load the active layer's MASK as
          // the document selection (the layer editors' Cmd-click on the
          // thumbnail). The mask's render becomes the selection's baked
          // base; the mask itself stays untouched. Works in both tabs -
          // a selection is a selection.
          item(
            "Selection from Mask",
            () => {
              const src = selectionLoadSource(state);
              if (!src) return;
              publishBusy("LOADING \u00b7 baking the mask into a selection");
              void bakeMaskRaster(state, src.id)
                .then((version) =>
                  dispatch({ type: "load_selection_from_mask", maskId: src.id, version }),
                )
                .catch((err) => reportToolError("Selection from Mask", err))
                .finally(() => publishBusy(null));
            },
            "menu-select-from-mask",
            !selectionLoadSource(state),
            undefined,
            "Load the active layer's mask in as the document selection, leaving the mask itself alone.",
            "Needs a layer or mask with something in it.",
          ),
          // Lifting makes its own layer, so unlike Fill it needs only
          // something selected. Finish-only: there is no layer stack to
          // put it on anywhere else.
          item(
            "Isolate Selection",
            go("select.to_layer"),
            "menu-select-to-layer",
            !has || state.panelTab !== "layers",
            "select.to_layer",
            "Make a new layer holding the photograph's own pixels from inside the selection.",
            state.panelTab !== "layers" ? FINISH : NEED,
          ),
          // Fill needs somewhere to put the color, so it also needs a
          // Finish layer to be active.
          item(
            "Fill Selection",
            go("select.fill"),
            "menu-select-fill",
            !has || !state.artActive || state.panelTab !== "layers",
            "select.fill",
            "Fill the selection with the paint color, on the layer you have active.",
            state.panelTab !== "layers"
              ? FINISH
              : !state.artActive
                ? "Select a layer in the FINISH panel to fill on."
                : NEED,
          ),
          // Remove Object erases what the selection covers - ANY selection,
          // smart or drawn - and the TAB decides where the result lives (The
          // report: "context matters... in Finish tab, the results should end
          // up in a Fill layer"). Adjustments splices the chain; Finish makes a
          // Fill layer. Enabled in both, unlike its strictly-Finish neighbors.
          item(
            "Remove Object",
            go("select.remove_object"),
            "menu-select-remove-object",
            !removeObjectSource(state),
            "select.remove_object",
            "Erase what the selection covers and let the model rebuild what was behind it.",
            NEED,
          ),
          <div key="s3" className="sep" />,
          // Three switches rather than three commands: they change how
          // the tool behaves next time, not what it does now.
          toggle(
            "Draw from Center",
            "selectFromCenter",
            "menu-select-from-center",
            "Draw the next selection outward from where you first press, instead of corner to corner.",
          ),
          toggle(
            "Antialias",
            "selectAntialias",
            "menu-select-antialias",
            "Give new selections a soft one-pixel edge rather than a stair-stepped one.",
          ),
          toggle(
            "Auto Clear on Click",
            "selectAutoClear",
            "menu-select-autoclear",
            "A click outside the selection clears it, instead of leaving it up until you deselect.",
          ),
          toggle(
            "Show Smart Clicks",
            "selectShowClicks",
            "menu-select-show-clicks",
            "Mark each smart click on the photograph while the tool is armed: green adds, red carves away.",
          ),
        ];
      })(),
    },
    {
      id: "photo",
      label: "Photo",
      items: [
        // The merge kind IS the menu item: no dialog to pick a mode in,
        // and every setting afterwards lives on the node like any other
        // control.
        <SubMenu
          key="rating"
          label="Rating"
          testid="menu-photo-rating"
          hint="Give the selected photographs a star rating, to sort and filter by later."
        >
          {[1, 2, 3, 4, 5].map((n) =>
            item(
              `${n} Star${n === 1 ? "" : "s"}`,
              () => rateSelection(state, dispatch, n),
              `menu-photo-rating-${n}`,
              false,
              `rate.${n}`,
              `Rate the selected photographs ${n} star${n === 1 ? "" : "s"}.`,
            )
          )}
          {item(
            "Clear",
            () => rateSelection(state, dispatch, 0),
            "menu-photo-rating-0",
            false,
            "rate.0",
            "Take the star rating off the selected photographs.",
          )}
        </SubMenu>,
        item(
          "Pick",
          () => flagSelection(state, dispatch, "pick"),
          "menu-photo-pick",
          false,
          "flag.pick",
          "Flag the selected photographs as keepers, so a filter can show only those.",
        ),
        item(
          "Reject",
          () => flagSelection(state, dispatch, "reject"),
          "menu-photo-reject",
          false,
          "flag.reject",
          "Flag the selected photographs as rejects, so a filter can hide them. Nothing is deleted.",
        ),
        item(
          "Clear Flag",
          () => flagSelection(state, dispatch, ""),
          "menu-photo-unflag",
          false,
          "flag.none",
          "Take the pick or reject flag off the selected photographs.",
        ),
        <div className="sep" key="sep-collections" />,
        // Collection errands, named for the collection they act on so
        // the menu says where the photo is going. The selection rule is
        // the queue's: a multi-selection travels together.
        ...(() => {
          const col = state.collections.find((c) => c.id === state.activeCollection);
          const ids = (state.imageSelection.length > 0
            ? state.imageSelection
            : [state.activeImage]
          ).filter(Boolean);
          const none = ids.length === 0;
          const PICK = "Select a photograph in the thumbnails first.";
          const OPEN = "Open a collection in the LIBRARY panel first.";
          return [
            item(
              col ? `Add to "${col.name}"` : "Add to Collection",
              () => void editCollectionMembership(state, dispatch, ids, "add"),
              "menu-photo-collection-add",
              none || !col,
              undefined,
              "Put the selected photographs in this collection. The files stay where they are on disk.",
              none ? PICK : OPEN,
            ),
            item(
              col ? `Remove from "${col.name}"` : "Remove from Collection",
              () => void editCollectionMembership(state, dispatch, ids, "remove"),
              "menu-photo-collection-remove",
              none || !col,
              undefined,
              "Take the selected photographs out of this collection. Their files and edits are untouched.",
              none ? PICK : OPEN,
            ),
            item(
              "Remove from All Collections",
              () => void editCollectionMembership(state, dispatch, ids, "remove-all"),
              "menu-photo-collection-remove-all",
              none || state.collections.length === 0,
              undefined,
              "Take the selected photographs out of every collection they are in.",
              none ? PICK : "There are no collections yet. Make one with + New in the LIBRARY panel.",
            ),
          ];
        })(),
        <div className="sep" key="sep-find" />,
        // Queues the selection (or the active photo) into the Export
        // panel's active batch group, and opens the panel so the add
        // is visible rather than silent.
        item(
          "Add to Export Queue",
          () => {
            const ids =
              state.imageSelection.length > 0 ? state.imageSelection : [state.activeImage];
            dispatch({ type: "export_queue_add", ids: ids.filter(Boolean) });
            if (!state.exportOpen) dispatch({ type: "toggle_export" });
          },
          "menu-photo-export-queue",
          !state.activeImage && state.imageSelection.length === 0,
          undefined,
          "Put the selected photographs in the Export panel's batch, ready to go out together.",
          "Select a photograph in the thumbnails first.",
        ),
        // The errand-sized sibling of the queue: selection (or active
        // photo) to a folder you pick, with the active batch's settings.
        item(
          "Quick Export…",
          () => void quickExport(state),
          "menu-photo-quick-export",
          !state.activeImage && state.imageSelection.length === 0,
          undefined,
          "Send the selected photographs straight to a folder you pick, using the current export settings.",
          "Select a photograph in the thumbnails first.",
        ),
        <div className="sep" key="sep-copy-edits" />,
        // Whole-graph copy: the active photo's edits, held until pasted.
        item(
          "Copy Edits",
          () => dispatch({ type: "copy_edits" }),
          "menu-photo-copy-edits",
          !state.activeImage,
          undefined,
          "Take a copy of this photograph's whole develop recipe, to paste onto others.",
          "Open a photograph first.",
        ),
        item(
          state.editClipboard
            ? `Paste Edits (from ${state.editClipboard.sourceName})`
            : "Paste Edits",
          () => {
            const targets =
              state.imageSelection.length > 0
                ? state.imageSelection
                : [state.activeImage].filter(Boolean);
            void pasteEditsTo(state, dispatch, targets).then((n) => {
              if (n > 0) logMsg("info", `Pasted edits onto ${n} photo${n === 1 ? "" : "s"}`);
            });
          },
          "menu-photo-paste-edits",
          !state.editClipboard ||
            (!state.activeImage && state.imageSelection.length === 0),
          undefined,
          "Apply the copied develop recipe to the selected photographs.",
          !state.editClipboard
            ? "Nothing copied yet: use Copy Edits on the photograph to copy from."
            : "Select the photographs to paste onto.",
        ),
        // Quad edit: the selection, edited as one. First selected drives.
        item(
          "Edit Together",
          () => {
            void openQuadEdit(state, dispatch, state.imageSelection);
          },
          "menu-photo-quad",
          state.imageSelection.length < 2 || state.imageSelection.length > 4,
          undefined,
          "Open two to four photographs side by side and edit them as one. The first one selected drives.",
          state.imageSelection.length > 4
            ? `That is ${state.imageSelection.length} selected; it takes two to four. Narrow the selection down.`
            : "Select between two and four photographs in the thumbnails.",
        ),
        // Linked photographs: a persistent Edit Together that is not tied to
        // the screen; edits to any member land on the rest.
        item(
          "Link Selected",
          () => void linkPhotos(state, dispatch, state.imageSelection),
          "menu-photo-link",
          linkHint(state, state.imageSelection).disabled,
          undefined,
          linkHint(state, state.imageSelection).hint,
          linkHint(state, state.imageSelection).hint,
        ),
        item(
          "Select Linked",
          () => {
            const group = state.images.find((i) => i.id === state.activeImage)?.linkGroup;
            dispatch({ type: "select_images", ids: state.images.filter((i) => i.linkGroup === group).map((i) => i.id) });
          },
          "menu-photo-select-linked",
          !state.images.find((i) => i.id === state.activeImage)?.linkGroup,
          undefined,
          "Selects every photograph linked with the open one, to see or act on them together.",
          "The open photograph is not linked.",
        ),
        // The deliberate sync: the link itself never copies values, it
        // moves every member by the same delta from where it is.
        item(
          "Match to This Photo",
          () => dispatch({ type: "link_match", id: state.activeImage }),
          "menu-photo-link-match",
          !state.images.find((i) => i.id === state.activeImage)?.linkGroup,
          undefined,
          "Copies the open photograph's edit onto every other photograph in its link; overrides hold, pinned ones sit it out.",
          "The open photograph is not linked.",
        ),
        item(
          "Unlink",
          () => void unlinkPhotos(state, dispatch, taggingTargets(state)),
          "menu-photo-unlink",
          !taggingTargets(state).some((id) => state.images.find((i) => i.id === id)?.linkGroup),
          undefined,
          "Takes the selected photographs out of their link; the rest of the link stays linked.",
          "None of the selected photographs is linked.",
        ),
        // Grayed when a filter is hiding the photo: scrolling to a
        // thumbnail that is not in the list can only do nothing.
        item(
          "Find in Thumbnails",
          () => revealActiveThumb(state, dispatch, { expand: true }),
          "menu-photo-find",
          !state.activeImage || !visibleImages(state).some((i) => i.id === state.activeImage),
          undefined,
          "Scroll the thumbnail strip to the photograph you are looking at, and flash it so the eye lands on it.",
          !state.activeImage
            ? "Open a photograph first."
            : "The current filter is hiding this photograph. Clear the filter and it can be found.",
        ),
        <div className="sep" key="sep-crop" />,
        <SubMenu
          key="crop"
          label="Crop / Straighten"
          testid="menu-photo-crop"
          hint="The framing tools: level the horizon, then crop, free or to a fixed shape."
        >
          {item(
            "Straighten",
            () => dispatch({ type: "set_tool", tool: "straighten" }),
            "menu-photo-straighten",
            false,
            "tool.straighten",
            "Drag a line along something that should be level and the photograph rotates to match.",
          )}
          {item(
            "Crop",
            () => dispatch({ type: "set_tool", tool: "crop" }),
            "menu-photo-cropinit",
            false,
            "tool.crop",
            "Drag the frame in to recompose. The pixels outside stay in the file and the crop can be undone at any time.",
          )}
          {item(
            "Grid Warp",
            () => dispatch({ type: "set_tool", tool: "gridwarp" }),
            "menu-photo-gridwarp",
            false,
            "tool.gridwarp",
            "Draw a grid over the photograph and drag its handles: the picture bends smoothly with them.",
          )}
          {item(
            "Shape Warp",
            () => dispatch({ type: "set_tool", tool: "shapewarp" }),
            "menu-photo-shapewarp",
            false,
            "tool.shapewarp",
            "Place shapes over the photograph and move, twist or pinch the picture under each.",
          )}
          <div className="sep" />
          <SubMenu
            label="Crop to Aspect Ratio"
            testid="menu-photo-aspect"
            hint="Hold the crop to a fixed shape while you drag it."
          >
            {item(
              "Free",
              () => {
                dispatch({ type: "set_tool", tool: "crop" });
                dispatch({ type: "set_crop_aspect", aspect: null });
              },
              "menu-photo-aspect-free",
              false,
              undefined,
              "Crop to any shape: no ratio held.",
            )}
            {cropRatioList(state.prefs).map(([label, ratio], i) => (
              // The person's saved ratios follow the shipped ones, past a
              // rule; their names are free text, so their ids count.
              <React.Fragment key={`${i}-${label}`}>
                {i === CROP_RATIOS.length && <div className="sep" />}
                {item(
                  label,
                  () => {
                    // Choosing a ratio without the crop tool up would
                    // constrain something the user cannot see.
                    dispatch({ type: "set_tool", tool: "crop" });
                    dispatch({ type: "set_crop_aspect", aspect: ratio });
                  },
                  i < CROP_RATIOS.length ? `menu-photo-aspect-${label.replace(":", "-")}` : `menu-photo-aspect-saved-${i - CROP_RATIOS.length}`,
                  false,
                  undefined,
                  `Hold the crop to ${label}, and arm the crop tool if it is not already up.`,
                )}
              </React.Fragment>
            ))}
            <div className="sep" />
            <CustomAspect dispatch={dispatch} />
          </SubMenu>
        </SubMenu>,
        check(
          "Flip Horizontal",
          photoFlips(state).h,
          () => dispatch({ type: "flip_photo", axis: "h" }),
          "menu-photo-flip-h",
          "Mirror the photograph left for right with every edit on it: masks, strokes, the crop and the layers. Again puts it back.",
          "photo.flip_h",
          !!photoFlipBlocked(state),
          flipWhy(state),
        ),
        check(
          "Flip Vertical",
          photoFlips(state).v,
          () => dispatch({ type: "flip_photo", axis: "v" }),
          "menu-photo-flip-v",
          "Mirror the photograph top for bottom with every edit on it: masks, strokes, the crop and the layers. Again puts it back.",
          "photo.flip_v",
          !!photoFlipBlocked(state),
          flipWhy(state),
        ),
        <div className="sep" key="sep-stack" />,
        <SubMenu
          key="stacking"
          label="Stacking"
          testid="menu-photo-stacking"
          disabled={state.imageSelection.length < 2}
          hint="Combine several frames of the same scene into one photograph."
          why="Select two or more photographs in the thumbnails."
        >
          {STACK_KINDS.map((k) =>
            item(
              k.label,
              () => void mergeSelection(state, dispatch, k.mode),
              `menu-photo-${k.mode}`,
              false,
              `photo.stack.${k.mode}`,
              // Each mode already describes itself for the thumbnail
              // menu that shares this list; one wording, both doors.
              k.hint,
            )
          )}
        </SubMenu>,
        item(
          "Stitch to Panorama…",
          () => void stitchSelection(state, dispatch),
          "menu-photo-panorama",
          state.imageSelection.length < 2,
          "photo.panorama",
          "Stitch the selected photographs into one wide frame, matching them where they overlap.",
          "Select two or more overlapping photographs in the thumbnails.",
        ),
        // Every available photograph can freeze its edits.
        item(
          "Bake to Image…",
          () => dispatch({ type: "open_bake", ids: taggingTargets(state) }),
          "menu-photo-bake",
          !bakeable(state).length,
          "photo.bake",
          "Freeze the edits in a new file beside the original, leaving the original untouched.",
          "Select an available photograph to bake its edits into a new file.",
        ),
        // The same pair the thumbnail's right-click carries ("Photo
        // menu should have the same Move to Trash and Relink tools as the
        // context menu"). Relink grays out unless something selected has
        // actually gone missing: an always-lit Relink invites re-pointing files
        // that are exactly where they should be. The context menu HIDES it for
        // the same reason; a menu bar item that comes and goes reads as a bug,
        // so here it grays.
        <div className="sep" key="sep-files" />,
        item(
          "Relink…",
          () => void relinkFrom(state, dispatch),
          "menu-photo-relink",
          !taggingTargets(state).some(
            (id) => state.images.find((i) => i.id === id)?.missing,
          ),
          undefined,
          "Point Heeler at where a moved photograph now lives, keeping its ratings, flags and edits.",
          "Nothing in the selection has gone missing.",
        ),
        item(
          "Move to Trash…",
          () => askTrash(state, dispatch),
          "menu-photo-trash",
          !taggingTargets(state).length,
          "image.trash",
          "Move the selected photographs into a .trash folder beside them. Heeler never empties it.",
          "Select a photograph in the thumbnails first.",
        ),
      ],
    },
    // Layers are a Develop activity: the panel is where they stack up,
    // and offering to add one from Graph would put it somewhere the user
    // is not looking.
    ...(state.mode === "simple"
      ? [
          {
            id: "layer",
            label: "Layer",
            items: [
              // The Finish stack's own actions, from the same list the panel's
              // right-click menu reads (src/layeractions.ts). "Make sure
              // all this functionality is also mirrored in the Layer menu." Two
              // hand-written menus drift the moment either one grows an item, so
              // there is one list and two doors onto it: the panel acts on the layer
              // you pointed at, this acts on the active one.
              //
              // Rename is the one item that does not travel: it starts
              // an inline edit on a row, and there is no row up here to
              // edit. It stays in the panel's menu.
              ...(() => {
                // With no layer active this used to collapse to one
                // grayed "No Layer Selected" line, which answered a
                // question nobody asked and hid the answer to the one
                // they did. layerActions takes a null now and hands
                // back the same list with everything off, each item
                // saying what it is for and how to reach it.
                const id = state.artActive;
                // Disable Layer Mask acts on the layer whose panel is
                // showing: the FINISH tab's active layer there, the
                // active Develop adjustment layer on the other tabs
                // (layerMaskToggleTarget). The panel's right-click menu
                // keeps the Finish layer it was opened on.
                const acts = layerActions(state, id).map((a) =>
                  a.kind === "item" && a.testid === "art-menu-mask-disable" ? maskToggleItem(layerMaskToggleTarget(state)) : a,
                );
                const shown = acts.filter(
                  (a) => a.kind === "sep" || a.testid !== "art-menu-rename",
                );
                return [
                  ...shown.map((a, i) => {
                    if (a.kind === "sep") return <div key={`s-art${i}`} className="sep" />;
                    // A fold-out here too, and the menu bar already has
                    // one: the groups list grows with the document.
                    if (a.kind === "submenu") {
                      return (
                        <div key={a.testid} data-hint={layerActionHint(a)}>
                          <SubMenu
                            label={a.label}
                            testid={`menu-layer-${a.testid.replace("art-menu-", "")}`}
                            disabled={a.disabled}
                          >
                            {a.items.map((child) =>
                              item(
                                child.label,
                                () => child.run(dispatch),
                                `menu-layer-${child.testid.replace("art-menu-", "")}`,
                              ),
                            )}
                          </SubMenu>
                        </div>
                      );
                    }
                    return item(
                      a.label,
                      () => a.run(dispatch),
                      `menu-layer-${a.testid.replace("art-menu-", "")}`,
                      a.disabled,
                      undefined,
                      layerActionHint(a),
                      undefined,
                      a.keys,
                    );
                  }),
                  <div key="s-art-end" className="sep" />,
                ];
              })(),
              // The Finish layer types, in the panel toolbar's grouping and order
              // (2026-09-30: the toolbar's "new layer buttons is confusing and sort
              // of sloppy looking"): Pixel, Gradient and Fill, the content you make;
              // then Adjustment, whose fold ends in a Utility section for Smart and
              // Warp ("Smart and Warp should be handled like Adjustments. I see them
              // as sort of a utility"); then Image, from a file or from this catalog.
              // The hints are the panel's own lines (finishnew.tsx), so the two seats
              // cannot explain the same layer two ways.
              //
              // Outside the block above on purpose. Those are actions on
              // the ACTIVE layer and there is none until one exists;
              // these are how the first one gets made, so they cannot be
              // gated on having one already. ART_ADJUSTMENTS is derived
              // from ART_KINDS, so a new adjustment kind arrives here on
              // its own.
              <SubMenu
                key="new-finish"
                label="New Finish Layer…"
                testid="menu-layer-new-finish"
                hint="Start a new layer on the Finish stack: paint, a gradient, a fill, an adjustment, a Smart or Warp layer, or an image."
              >
                {ART_CONTENT_KINDS.map((k) =>
                  item(
                    `${ART_KINDS[k].label} Layer`,
                    () => addContentLayer(dispatch, k),
                    `menu-finish-${k}`,
                    false,
                    undefined,
                    `${CONTENT_ITEMS[k].hint}.`,
                  ),
                )}
                <div key="s-finish-content" className="sep" />
                <SubMenu
                  key="finish-adj"
                  label="Adjustment Layer…"
                  testid="menu-finish-adjust"
                  hint={`${ADJUST_SEAT.hint}.`}
                >
                  {adjustmentItems().map((it) =>
                    item(it.label, () => it.run(state, dispatch), `menu-finish-adjust-${it.id}`, false, undefined, `${it.hint}.`),
                  )}
                  <div key="s-finish-utility" className="sep" />
                  <div key="hd-finish-utility" className="hd" data-testid="menu-finish-utility">UTILITY</div>
                  {UTILITY_ITEMS.map((it) =>
                    item(it.label.replace(" layer", " Layer"), () => it.run(state, dispatch), `menu-finish-${it.id}`, false, undefined, `${it.hint}.`),
                  )}
                </SubMenu>
                <SubMenu
                  key="finish-image"
                  label="Image Layer…"
                  testid="menu-finish-image"
                  hint={`${IMAGE_SEAT.hint}.`}
                >
                  {IMAGE_ITEMS.map((it) =>
                    item(it.label, () => it.run(state, dispatch), `menu-image-layer-${it.id}`, false, undefined, `${it.hint}.`),
                  )}
                </SubMenu>
              </SubMenu>,
              // Layers out of a file on disk (26.3 Phase 7 import): the
              // picker lists what the file holds and makes one image
              // layer per chosen entry. Its own seat beside New Finish
              // Layer rather than inside it: those make blank layers,
              // this one reads a file.
              item(
                "Layers from File…",
                () => {
                  void pickImageFile().then(async (p) => {
                    if (!p) return;
                    const passes = await filePassesAt(p);
                    dispatch({ type: "open_file_layers", path: p, passes });
                  });
                },
                "menu-layer-from-file",
                false,
                undefined,
                "Read the pages of a multi-page TIFF or the layers of an OpenEXR as Finish image layers, referenced from the file in place.",
              ),
              // The layer editors' Layer via Copy (2026-09-30): the pixels inside the
              // selection on a layer of their own, above the active one, to move,
              // transform and warp. Beside the other door that makes an image layer out
              // of pixels.
              (() => {
                const sel = activeSelectionMask(state);
                const ready = !!sel && selectionHasContent(sel) && state.panelTab === "layers";
                return item(
                  "New Layer via Copy",
                  () => runCommand("layer.via_copy", state, dispatch),
                  "menu-layer-via-copy",
                  !ready,
                  "layer.via_copy",
                  "Copy the pixels inside the selection to a new layer above the active one, to move and warp.",
                  state.panelTab !== "layers" ? "Switch to the FINISH tab, where the layer stack lives." : "Draw a selection first.",
                );
              })(),
              // The Develop masks, folded away. "the layers at the bottom
              // that are specific to Adjustments should be moved into a sub menu for
              // New Adjustment Layer... >". They are a different thing from the Finish
              // actions above them (an adjustment behind a mask, not a layer of
              // paint), and a row of items of one kind at the foot of a menu reads as
              // the menu's subject rather than as one branch of it.
              //
              // Built from LAYER_MASK_TYPES rather than written out.
              // Hand-writing them is what left Smart off this menu while
              // it worked everywhere else in the app ("Select
              // > New Adjustment Layer... Is missing Smart Layer"), and
              // that list exists to carry exactly this: "a new mask type
              // could be everywhere else in the app and still have no
              // button to make one".
              <SubMenu
                key="new-adj"
                label="New Adjustment Layer…"
                testid="menu-layer-new-adjustment"
                hint="Add a Develop adjustment behind a mask, and choose how that mask gets its shape."
              >
                {availableMaskTypes(state).map((t) =>
                  item(
                    `${t[0].toUpperCase()}${t.slice(1)} Layer`,
                    () => dispatch({ type: "add_layer", maskType: t }),
                    `menu-layer-${t}`,
                    false,
                    `layer.${t}`,
                    MASK_TYPE_HINTS[t],
                  ),
                )}
              </SubMenu>,
            ],
          },
        ]
      : []),
    // Nodes are a Graph and Canvas activity: in Develop the panel is the
    // graph, and a menu of node types there would be offering to build
    // something the user cannot see.
    ...(state.mode !== "simple"
      ? [
          {
            id: "node",
            label: "Node",
            items: [
              item(
                "Find a Node…",
                () => dispatch({ type: "open_palette" }),
                "menu-node-search",
                false,
                "node.palette",
                "Search every node by name and drop the one you pick into the graph.",
              ),
              <div className="sep" key="sep-node" />,
              // Category, then section, then node: the graph's Add
              // menu's tree (menuTree), so both doors list the same.
              ...menuTree().map((family) => (
                <SubMenu
                  key={family.cat}
                  label={family.label}
                  testid={`menu-node-${family.cat}`}
                  hint={`Add a ${family.label.toLowerCase()} node to the graph.`}
                  scroll={false}
                >
                  {family.sections.map((section) => (
                    <SubMenu
                      key={section.id}
                      label={section.label}
                      testid={`menu-node-section-${section.id}`}
                      hint={`Add a node from ${family.label} > ${section.label}.`}
                    >
                      {section.nodes.map((spec) =>
                        item(
                          spec.name,
                          () => addNodeAt(state, dispatch, spec),
                          `menu-node-add-${spec.type.replace("heeler.", "")}`,
                          false,
                          undefined,
                          // Every node already carries its one line for
                          // the palette. One wording, both doors.
                          spec.blurb,
                        )
                      )}
                    </SubMenu>
                  ))}
                </SubMenu>
              )),
            ],
          },
        ]
      : []),
    {
      id: "view",
      label: "View",
      items: [
        item("Expand All Sections", () => runCommand("view.sections.expand", state, dispatch), "menu-view-sections-expand", false, "view.sections.expand", "Opens every adjustment section, the ones the filter chips leave out too; sections hidden in Preferences stay hidden. Option-click a closed section to do the same."),
        item("Collapse All Sections", () => runCommand("view.sections.collapse", state, dispatch), "menu-view-sections-collapse", false, "view.sections.collapse", "Folds every adjustment section, the ones the filter chips leave out too; sections hidden in Preferences stay hidden. Option-click an open section to do the same."),
      ],
    },
    // The Window menu (2026-09-09): every pop-out as a switch, the way
    // home for a window pushed off a display, the frame around the
    // photograph, and the main window itself. Before Help, where a Window
    // menu sits everywhere else.
    {
      id: "window",
      label: "Window",
      items: [
        check("Graph in its own window", state.graphPoppedOut, () => {
          // The flag's effect opens the window; this keeps the opener
          // for the focus to come back to (rememberPopoutOpener).
          if (!state.graphPoppedOut) rememberPopoutOpener("graph", document.querySelector<HTMLElement>('[data-testid="menu-window"]'));
          dispatch({ type: "set_graph_popped_out", out: !state.graphPoppedOut });
        }, "menu-window-graph",
          "Puts the node graph in a window of its own, with the Inspector beside it; the main window keeps the photograph.", "window.graph",
          state.mode === "simple" && !state.graphPoppedOut, "Switch to Graph or Canvas first."),
        check("Spectrums window", state.spectrumsPoppedOut, () => dispatch({ type: "set_spectrums_popped_out", out: !state.spectrumsPoppedOut }), "menu-window-spectrums",
          "Opens the spectrums in a larger window of their own, draggable to a second display.", "window.spectrums"),
        check("Takes window", state.takesPoppedOut, () => dispatch({ type: "set_takes_popped_out", out: !state.takesPoppedOut }), "menu-window-takes",
          "Opens the Takes review window: notes, star ratings and compare, with room to read.", "window.takes"),
        check("Color Bend window", state.bendPoppedOut, () => dispatch({ type: "set_bend_popped_out", out: !state.bendPoppedOut }), "menu-window-bend",
          "Opens the Color Bend editor in a window of its own.", "window.bend"),
        <SubMenu key="menu-window-tools" label="Tool windows" testid="menu-window-tools" hint="Each adjustment tool that can work in a window of its own, as a switch.">
          {(Object.keys(TOOL_WINDOWS) as ToolWindowKind[]).map((kind) =>
            check(TOOL_WINDOWS[kind].title.replace(/^Heeler /, ""), state.toolPopouts[kind],
              () => dispatch({ type: "set_tool_popped_out", tool: kind, out: !state.toolPopouts[kind] }),
              `menu-window-tool-${kind}`, `Opens ${TOOL_WINDOWS[kind].title.replace(/^Heeler /, "")} in a window of its own; the panel folds to a bar while it is out.`),
          )}
        </SubMenu>,
        check("Console", consoleLive, () => void import("../ui/console").then(({ toggleConsoleWindow }) => toggleConsoleWindow()), "menu-window-console",
          "Opens the console in its own window: the session log with a DEBUG switch, and the Python scratchboard.", "view.console"),
        <div key="sep-window-1" className="sep" />,
        item("Bring all windows back", () => dispatch({ type: "dock_all_windows" }), "menu-window-dock-all", false, "window.dock_all",
          "Docks every pop-out window into the main window, the way home for one pushed off a display."),
        item("Reset layout", () => dispatch({ type: "reset_layout" }), "menu-window-reset-layout", false, "view.layout_reset",
          "Puts the Library, thumbnails, panels and their sizes back to a fresh launch's; the pop-outs are left as they are."),
        <div key="sep-window-2" className="sep" />,
        check("Library", state.browserOpen, () => dispatch({ type: "toggle_browser" }), "menu-window-library", "Shows or hides the Library panel on the left.", "view.browser"),
        check("Thumbnails", state.ribbonOpen, () => dispatch({ type: "toggle_ribbon" }), "menu-window-ribbon", "Shows or hides the thumbnail strip.", "view.ribbon"),
        <SubMenu key="menu-window-ribbon-view" label="Thumbnail strip as" testid="menu-window-ribbon-view" hint="Thumbnails or a list of names and ratings, in the strip.">
          {check("Thumbnails", state.ribbonView === "thumbs", () => dispatch({ type: "set_ribbon_view", view: "thumbs" }), "menu-window-ribbon-thumbs", "Pictures in the strip, with stars and flags under each.")}
          {check("List", state.ribbonView === "list", () => dispatch({ type: "set_ribbon_view", view: "list" }), "menu-window-ribbon-list", "A table in the strip: name, rating and flag per row, more rows in the same height.")}
        </SubMenu>,
        // The filter, not the visibility list: Preferences > Interface >
        // Adjustment sections is where a section is hidden, so this
        // submenu is named for what it does and says so.
        <SubMenu key="menu-window-sections" label="Adjustments filter" testid="menu-window-sections" hint="Which of the listed sections the panel shows: every one, the pinned ones, or the ones switched on; sections hidden in Preferences stay out.">
          {check("All", state.sectionFilter === "all", () => dispatch({ type: "set_section_filter", filter: "all" }), "menu-window-sections-all", "Every listed section, the pinned ones first.")}
          {check("Pinned", state.sectionFilter === "pinned", () => dispatch({ type: "set_section_filter", filter: "pinned" }), "menu-window-sections-pinned", "Only the sections you pinned; right-click a section's header to pin it.")}
          {check("On", state.sectionFilter === "on", () => dispatch({ type: "set_section_filter", filter: "on" }), "menu-window-sections-on", "Only the sections switched on for this photograph.")}
        </SubMenu>,
        <div key="sep-window-3" className="sep" />,
        ...MODES.map((m) =>
          check(m.label, state.mode === m.id, () => dispatch({ type: "set_mode", mode: m.id }), `menu-window-mode-${m.id}`,
            m.id === "simple" ? "The Develop workspace: the photograph with the Adjustments panel." : m.id === "advanced" ? "The Graph workspace: the node graph under the photograph, with the Inspector." : "The Canvas workspace: the graph floating over the photograph.",
            m.id === "simple" ? "view.mode.develop" : m.id === "advanced" ? "view.mode.graph" : "view.mode.canvas"),
        ),
        <div key="sep-window-4" className="sep" />,
        <SubMenu key="menu-window-zoom" label="App zoom" testid="menu-window-zoom" hint="Scales every control, the same setting Preferences has; the photograph is never scaled.">
          {CHROME_ZOOM_STEPS.map((z) =>
            check(`${Math.round(z * 100)} percent`, chromeZoom === z, () => { setUiPref("chromeZoom", z); applyChromeZoom(z); }, `menu-window-zoom-${Math.round(z * 100)}`,
              `Scales app controls to ${Math.round(z * 100)} percent.`),
          )}
        </SubMenu>,
        item("Full screen", () => void toggleFullscreen().catch(() => {}), "menu-window-fullscreen", false, "view.fullscreen",
          "Fills the display with Heeler, or leaves full screen when it is already there."),
        item("Center main window", () => void centerMainWindow().catch(() => {}), "menu-window-center", !isTauri(), "view.center_window",
          "Brings the main window back to the middle of its display, for one dragged out of reach.", "Available in the desktop app."),
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [
        // A tester, via "It would be helpful if a user could
        // search for a tool under the Help menu." The search indexes
        // CONTROLS by name and takes you to the one you pick.
        item(
          "Find a Control…",
          () => dispatch({ type: "toggle_find_control" }),
          "menu-help-find",
          false,
          undefined,
          "Search every control in the app by name, and go straight to the one you pick.",
        ),
        // The docs render from the install's own .md files, so what the
        // menu opens is always what shipped, never a copy that drifted.
        item(
          "User Documentation",
          () => dispatch({ type: "open_docs" }),
          "menu-help-docs",
          false,
          undefined,
          "Open the user guide that shipped with this build, so it always matches what you are running.",
        ),
        // The license, the privacy policy and the notices, out of the
        // guide that shipped, so they can be read inside the app rather
        // than only on a website.
        item(
          LEGAL_MENU_LABEL,
          () => dispatch({ type: "open_docs", file: "legal/README.md" }),
          "menu-help-legal",
          false,
          undefined,
          "Open the license, the privacy policy and the open-source notices that shipped with this build.",
        ),
        item(
          "About Heeler",
          () => {
            // The build number is the answer to "what are you running?"
            // in every license and bug email, so About must say it.
            void buildInfo().then((b) => {
              logMsg("info", `Heeler ${b} · node-based RAW developer · www.heeler.app · © 2026 Vagabond Burro LLC`);
              // Attribution has to be reachable from About, not only
              // from a page somebody would have to already know about.
              // LibRaw is used under CDDL-1.0, which obliges us to say
              // that its source is available and where; the notice
              // carries that, and this is the signpost to it.
              //
              // The path here has to match where the notice actually
              // lives, and once it did not: the guide became a tree and
              // the notice was left behind in the old flat folder, so
              // this line pointed at a page that no longer shipped.
              // `menuPathToOpenSource` in the docs test is what holds
              // the two together now.
              logMsg(
                "info",
                `Built on LibRaw (CDDL-1.0), zlib and mozjpeg. Source, notices and warranty terms: ${OPEN_SOURCE_MENU_PATH}, or www.heeler.app/source/libraw/`,
              );
            });
            void import("../popout").then(({ openConsoleWindow }) => openConsoleWindow());
          },
          "menu-help-about",
          false,
          undefined,
          "Show the build number and the open source notices in the console. The build number is what a bug report needs.",
        ),
        // Check and link, never download: the dialog says whether a
        // newer release exists, and its Download hands the installer to
        // the browser. The launch-time check is a preference; this item
        // asks regardless.
        item(
          "Check for Updates…",
          () => void checkForUpdates("menu"),
          "menu-help-updates",
          false,
          undefined,
          `Find out whether a newer Heeler exists. ${UPDATE_DOWNLOAD_WORDS}`,
        ),
      ],
    },
  ];
  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "center", gap: 2, position: "relative" }} data-testid="menubar">
      {menus.map((m) => (
        <div key={m.id} style={{ position: "relative" }}>
          <button
            aria-haspopup="menu" aria-expanded={open === m.id}
            data-testid={`menu-${m.id}`}
            data-active={open === m.id}
            onClick={() => setOpen(open === m.id ? null : m.id)}
            onMouseEnter={() => open !== null && setOpen(m.id)}
            style={{
              all: "unset", cursor: "pointer", padding: "4px 9px", fontSize: 11,
              color: open === m.id ? "var(--text-strong)" : "var(--text-dim)",
              background: open === m.id ? "#1f2426" : "transparent",
            }}
          >
            {m.label}
          </button>
          {open === m.id && (
            <MenuSurface aria-label="Commands" className="ctx-menu" style={{ left: 0, top: "calc(100% + 2px)", position: "absolute" }} data-testid={`menu-${m.id}-list`}>
              {m.items}
            </MenuSurface>
          )}
        </div>
      ))}
      {/* One entry's own menu, over the File menu it belongs to. Fixed
          and clamped the way the section and layer menus are. */}
      {recentMenu && (() => {
        const z = chromeZoomFactor();
        const vp = viewportSize();
        const at = clampMenu({ x: recentMenu.x / z, y: recentMenu.y / z }, { w: 250, h: 60 }, { w: vp.w / z, h: vp.h / z });
        return createPortal(
          <MenuSurface
            ref={recentMenuRef}
            className="ctx-menu"
            role="menu"
            aria-label={`${recentMenu.name} in the recent list`}
            data-testid="recent-catalog-menu"
            style={{ position: "fixed", width: 250, left: at.x, top: at.y, zIndex: 80 }}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setRecentMenu(null); }
            }}
          >
            <div className="hd">{recentMenu.name.toUpperCase()}</div>
            <div className="sep" />
            <div data-hint="Take this catalog off the list. The database stays where it is, and opening it again puts it back.">
              <button
                data-testid="recent-catalog-forget"
                disabled={recentChanging}
                onClick={() => {
                  const path = recentMenu.path;
                  setRecentMenu(null);
                  void changeRecent(() => forgetRecentCatalog(path));
                }}
              >
                Remove from this list
              </button>
            </div>
          </MenuSurface>,
          document.body,
        );
      })()}
    </div>
  );
}

/** Custom window controls; the native title bar is off (decorations:
 * false), the top bar is the drag region. */
/** The app mark, straight from the icon the bundle ships, so the window
 * and the taskbar wear the same face. */
export function AppIcon({ size = 16 }: { size?: number }) {
  return (
    <img
      src="/heeler-icon.svg"
      alt=""
      width={size}
      height={size}
      data-testid="app-icon"
      draggable={false}
      data-tauri-drag-region
      style={{ borderRadius: size / 4.6, display: "block", flex: "none" }}
    />
  );
}

/** Clearance for the macOS traffic lights, which the OS paints over
 * our chrome (titleBarStyle Overlay): the bar's content starts after
 * them instead of underneath them. 56px plus the bar's own 12px
 * left padding lands at ~78 screen points once the 1.15 ui-zoom
 * applies, clearing the three lights. Renders nothing off-Mac. */
export function MacInset() {
  if (!isMac()) return null;
  return <div data-testid="mac-inset" data-tauri-drag-region style={{ width: 56, flex: "none", alignSelf: "stretch" }} />;
}

/** The one button every popped-out window docks with: an icon in the
 * ribbon's icon-chip box, the same size and glyph in every window (The
 * report: "this button is not the same size in all occurrences of pop
 * outs"), with the words in its tooltip. On macOS nothing follows it
 * on the right, so it keeps its own margin from the window's edge (The
 * report: "pushed right up to the edge of the pop out window almost
 * getting clipped"); elsewhere the window controls follow and carry
 * their own box.*/
export function DockButton({ testid, hint, onClick }: { testid: string; hint: string; onClick: () => void }) {
  return (
    <button
      className="chip"
      data-testid={testid}
      data-hint={hint}
      aria-label={hint}
      style={{ ...RIBBON_ICON_CHIP, marginRight: isMac() ? 10 : 0 }}
      onClick={onClick}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
        {/* A window, and an arrow coming home into it. */}
        <path d="M4 8v12h12V8" />
        <path d="M4 8h12" />
        <path d="M20 4l-7 7M13 4v7h7" />
      </svg>
    </button>
  );
}

export function WindowControls() {
  // On macOS the OS's own traffic lights do this job (top-left, via
  // MacInset); a second set of controls on the right would be the odd
  // one out on the platform.
  if (isMac()) return null;
  return <WindowControlButtons />;
}

function WindowControlButtons() {
  const call = async (action: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri()) return;
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "minimize") await w.minimize();
    else if (action === "toggleMaximize") await w.toggleMaximize();
    else await w.close();
  };
  // On Windows a native overlay sits over the maximize button so that
  // hovering it brings up Snap Layouts (snaplayouts.ts). The overlay
  // takes the mouse with it, so its hover comes back here as an event
  // and lights the button the same way the mouse handlers below do.
  const maximizeRef = useRef<HTMLButtonElement>(null);
  useEffect(
    () =>
      watchMaximizeButton(maximizeRef.current, (hovering) => {
        const b = maximizeRef.current;
        if (b) b.style.background = hovering ? "#1f2426" : "transparent";
      }),
    [],
  );
  const btn = (label: string, action: Parameters<typeof call>[0], path: string, danger = false) => (
    <button
      ref={action === "toggleMaximize" ? maximizeRef : undefined}
      aria-label={label}
      data-hint={label}
      data-testid={`win-${action}`}
      onClick={() => void call(action)}
      style={{ all: "unset", cursor: "pointer", width: 34, height: 30, display: "flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = danger ? "#7a2b22" : "#1f2426")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#9ea2a5" strokeWidth="2">
        <path d={path} />
      </svg>
    </button>
  );
  return (
    <div style={{ display: "flex", alignItems: "center", marginLeft: 4 }} data-testid="window-controls">
      {btn("Minimize", "minimize", "M5 12h14")}
      {btn("Maximize", "toggleMaximize", "M6 6h12v12H6z")}
      {btn("Close", "close", "M6 6l12 12M18 6L6 18", true)}
    </div>
  );
}

function TopBarImpl({ state, dispatch }: { state: State; dispatch: D }) {
  const barRef = useRef<HTMLDivElement>(null);
  const fileName = state.images.find((i) => i.id === state.activeImage)?.name ?? state.activeImage;
  const barFit = useTopBarFit(barRef, state.layoutRoom, `${state.libraryLabel}\n${fileName}`);
  return (
    <div ref={barRef} className="topbar ui-zoom" data-testid="topbar" data-tauri-drag-region style={barFit.zoom ? { zoom: barFit.zoom } : undefined}>
      <MacInset />
      <div className="brand" data-tauri-drag-region>
        <AppIcon />
        <span data-tauri-drag-region>HEELER</span>
      </div>
      <div className="vsep" />
      {/* No mode name here: the lit tab on the right already says it (The
report: "it is redundant to have DEVELOP left of the menus when its
highlighted on the right"). The popped-out graph window keeps its
own label, having no tabs to be redundant with.*/}
      <MenuBar state={state} dispatch={dispatch} />
      <div className="center" data-tauri-drag-region data-testid="topbar-title" style={barFit.titleShown ? undefined : { visibility: "hidden" }}>
        <span data-tauri-drag-region>{state.libraryLabel}</span>
        <div className="vsep" style={{ height: 12 }} />
        <span className="file tnum" data-tauri-drag-region>
          {fileName}
        </span>
      </div>
      {/* marginLeft auto: the centered title left the flex flow (it is
          absolute against the bar now), so the right cluster pushes
          itself to the edge. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
        <div className="seg" role="tablist" aria-label="Workspace mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              aria-pressed={state.mode === m.id}
              aria-label={m.label}
              data-testid={`mode-${m.id}`}
              data-hint={`${m.label} workspace`}
              data-hint-cmd={
                m.id === "simple" ? "view.mode.develop" : m.id === "advanced" ? "view.mode.graph" : "view.mode.canvas"
              }
              style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: 34 }}
              onClick={() => dispatch({ type: "set_mode", mode: m.id })}
            >
              {/* 1.15x: the glyph grows, the button does not; the negative margin
hands the extra height back to the button so the tab strip keeps
its size.*/}
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" style={{ display: "block", margin: "-2px 0" }}>
                <path d={m.icon} />
              </svg>
            </button>
          ))}
        </div>
        <button
          className="btn-assistant"
          aria-label="Console"
          data-testid="btn-console"
          data-hint="Console"
          data-hint-cmd="view.console"
          onClick={() => void import("../ui/console").then(({ toggleConsoleWindow }) => toggleConsoleWindow())}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#9ea2a5" strokeWidth="1.6">
            <path d="M4 17l6-5-6-5M12 19h8" />
          </svg>
        </button>
        {/* The Assistant button returns when the agentic side is settled;
hidden for the closed tester round.*/}
        <ExportButton state={state} dispatch={dispatch} />
        <WindowControls />
      </div>
    </div>
  );
}

/** The EXPORT button in the title bar is a QUICK export: one click, one
 * file, the save dialog picks where. It used to open the export panel,
 * which the sidebar bar and Ctrl+E already do; two doors to the same
 * room made the loud one redundant. "I don't think we need
 * the big yellow EXPORT button that does the same thing as the
 * sidebar. UNLESS you turn that into a quick Export."
 *
 * JPG by default, PNG while ALT is held. Right-click opens the small
 * settings popover; so does Ctrl/Cmd+click, which settles the
 * Ctrl-versus-right-click question by taking both (on a Mac, Ctrl+click
 * IS a right-click).
 */
function ExportButton({ state, dispatch }: { state: State; dispatch: D }) {
  const [alt, setAlt] = useState(false);
  const [open, setOpen] = useState(false);
  const root = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  useEffect(() => {
    const down = (e: KeyboardEvent) => e.key === "Alt" && setAlt(true);
    const up = (e: KeyboardEvent) => e.key === "Alt" && setAlt(false);
    // Cmd+Tab away with ALT down would wedge the label on PNG.
    const drop = () => setAlt(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", drop);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", drop);
    };
  }, []);

  const p = state.prefs;
  const run = async (png: boolean) => {
    if (!state.activeImage) {
      logMsg("warn", "Quick Export: no photograph open");
      return;
    }
    try {
      const path = await exportImage(state, {
        format: png ? "png" : "jpeg",
        quality: p.quickQuality,
        maxEdge: p.quickResize === "edge" ? p.quickEdge : null,
        scalePercent: p.quickResize === "percent" ? p.quickPercent : null,
        keepMetadata: p.exportKeepMetadata ?? true,
        dpi: exportDpi(p.quickDpi),
      });
      if (path) logMsg("info", `Exported ${path}`);
    } catch (e) {
      logMsg("error", `Quick Export failed: ${String(e)}`);
    }
  };
  const setPref = (prefs: Partial<State["prefs"]>) => dispatch({ type: "set_prefs", prefs });

  const sizeChip = (id: State["prefs"]["quickResize"], label: string) => (
    <button
      key={id}
      className="chip"
      data-testid={`quick-size-${id}`}
      data-active={p.quickResize === id}
      style={{
        fontSize: 9,
        padding: "1px 7px",
        color: p.quickResize === id ? "var(--accent)" : "var(--text-ghost)",
        borderColor: p.quickResize === id ? "var(--accent)" : "var(--line-4)",
      }}
      onClick={() => setPref({ quickResize: id })}
    >
      {label}
    </button>
  );

  return (
    <div ref={root} style={{ position: "relative", display: "inline-flex" }}>
      <button
        className="btn-export"
        data-testid="btn-export"
        data-hint={`Quick Export as JPG · hold ${modLabel("alt")} for PNG · right-click for settings`}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey) setOpen(true);
          else void run(e.altKey);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {/* An arrow leaving a tray says EXPORT in less room than the word did.
"Is there an icon you can create to replace the text?"
The format keeps its fixed-width slot: JPG and PNG measure
differently in a proportional face, and a button that breathes when
ALT goes down reads as a layout bug.*/}
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flex: "none", marginRight: 5 }}
        >
          <path d="M8 10V2.5M4.8 5.7 8 2.5l3.2 3.2" />
          <path d="M2.8 10.5v3h10.4v-3" />
        </svg>
        <span style={{ display: "inline-block", width: "3.6ch", textAlign: "left" }}>
          {alt ? "PNG" : "JPG"}
        </span>
      </button>
      {open && (
        <div
          data-testid="quick-export-menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 40, width: 208,
            background: "#191817", border: "1px solid var(--line-4)",
            boxShadow: "0 6px 18px rgba(0,0,0,.5)", padding: "9px 10px 9px",
          }}
        >
          <div className="kicker" style={{ fontSize: 8, marginBottom: 6 }}>Quick Export</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text-faint)", width: 44 }}>Quality</span>
            <div className="strack-flex">
              <TrackSlider
                label="Quick export quality"
                lo={1}
                hi={100}
                step={1}
                testid="quick-quality"
                value={p.quickQuality}
                onChange={(v) => setPref({ quickQuality: v })}
              />
            </div>
            <div style={{ width: 20, flex: "none", fontSize: 10 }}>
              <ValueField
                param="quick export quality"
                value={p.quickQuality}
                lo={1}
                hi={100}
                display={(v) => String(Math.round(v))}
                testid="quick-quality-value"
                onCommit={(v) => setPref({ quickQuality: Math.round(v) })}
              />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text-faint)", width: 44 }}>Size</span>
            {sizeChip("full", "Full")}
            {sizeChip("edge", "px")}
            {sizeChip("percent", "%")}
            {p.quickResize !== "full" && (
              <ValueField
                key={p.quickResize}
                param="quick_size"
                testid="quick-size-value"
                value={p.quickResize === "edge" ? p.quickEdge : p.quickPercent}
                lo={1}
                hi={p.quickResize === "edge" ? 65536 : 99}
                display={String}
                step={1}
                onCommit={(v) => {
                  if (p.quickResize === "edge") setPref({ quickEdge: Math.round(v) });
                  else setPref({ quickPercent: Math.round(v) });
                }}
              />
            )}
          </div>
          {/* The print resolution the file declares (2026-10-06: "make
sure its in the quick export").*/}
          <div style={{ display: "flex", alignItems: "center", gap: 5, marginBottom: 8 }}>
            <span style={{ fontSize: 10, color: "var(--text-faint)", width: 44 }}>DPI</span>
            <ValueField
              param="quick_dpi"
              testid="quick-dpi"
              label="Quick export DPI"
              hint="The print resolution the file declares. The pixels stay the same; only the size a print shop or layout program reads changes"
              value={exportDpi(p.quickDpi)}
              lo={1}
              hi={exportResolution.maxDpi}
              display={String}
              step={1}
              onCommit={(v) => setPref({ quickDpi: exportDpi(v) })}
            />
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button
              className="chip"
              data-testid="quick-export-png"
              style={{ padding: "2px 8px" }}
              onClick={() => {
                setOpen(false);
                void run(true);
              }}
            >
              PNG…
            </button>
            <button
              className="chip"
              data-testid="quick-export-jpg"
              style={{ padding: "2px 8px", color: "var(--accent)", borderColor: "var(--accent)" }}
              onClick={() => {
                setOpen(false);
                void run(false);
              }}
            >
              JPG…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The funnel, and everything behind it.
 *
 * The filters used to be two rows of chips across the top of the ribbon,
 * which is a lot of permanent furniture for something that is off most
 * of the time and reads as clutter when it is. One button, a badge when
 * anything is narrowing the list, and the controls themselves in a
 * popover where there is room to label them.
 *
 * The count stays outside, because "43/139" is the one thing worth
 * seeing without opening anything: a filter you have forgotten about
 * looks exactly like a folder that lost its photos.
 *
 * The picture browser seats the same controls in its header instead
 * (FilterControls, inline): with its actions gone to icons there is
 * room, and (2026-09-15) asked to see the filters there "so we don't
 * have to use the pop up menu". One set of controls, two seats.
 */
export function FilterMenu({
  state,
  dispatch,
  align = "left",
}: {
  state: State;
  dispatch: D;
  /** Which edge of the button the dropdown hangs from. The ribbon
   * seats the button at the panel's right edge, where a left-anchored
   * 216px menu would hang out of the panel. */
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const on = filtersActive(state);
  return (
    <div ref={rootRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 6 }}>
      <button
        className="chip"
        data-testid="filter-open"
        data-active={open}
        aria-label="Filter"
        data-hint="Filter which photos the ribbon shows"
        style={{
          ...RIBBON_ICON_CHIP,
          color: on ? "var(--accent)" : "var(--text-ghost)",
          borderColor: on ? "var(--accent)" : "var(--line-4)",
        }}
        onClick={() => setOpen(!open)}
      >
        {/* The funnel alone ("remove the label from the filter
button and just show the icon"); the shape is the word, and the
active dot still says a filter is in force.*/}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 4h18l-7 8v7l-4 2v-9z" />
        </svg>
        {on && (
          <span
            data-testid="filter-active-dot"
            style={{ width: 4, height: 4, borderRadius: 4, background: "var(--accent)" }}
          />
        )}
      </button>

      {open && (
        <div
          data-testid="filter-menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", ...(align === "right" ? { right: 0 } : { left: 0 }), zIndex: 40, width: 216,
            background: "#191817", border: "1px solid var(--line-4)",
            boxShadow: "0 6px 18px rgba(0,0,0,.5)", padding: "9px 10px 6px",
          }}
        >
          <FilterControls state={state} dispatch={dispatch} />
        </div>
      )}
    </div>
  );
}

/** The filter controls themselves: name, tag, rating, flags, kind,
 * takes and CLEAR ALL. Stacked under labels in the funnel's popover;
 * `inline`, one row at the picture browser's button height, the labels
 * folded into placeholders and hints, wrapping to a second line when
 * the window is narrow. The two seats share this so a filter set in
 * one is the filter the other shows. */
export function FilterControls({
  state,
  dispatch,
  inline = false,
}: {
  state: State;
  dispatch: D;
  inline?: boolean;
}) {
  const on = filtersActive(state);
  // The tag filter is catalog-backed: the term resolves to ids through
  // the keyword store once, and visibleImages checks membership. The
  // draft is what is typed; the filter is what has been applied.
  const [tagDraft, setTagDraft] = useState(state.tagFilter?.term ?? "");
  const [knownTags, setKnownTags] = useState<string[]>([]);
  // CLEAR (and anything else that drops the filter) empties the box too;
  // a box still showing "bride" over an unfiltered folder is a lie.
  useEffect(() => {
    setTagDraft(state.tagFilter?.term ?? "");
  }, [state.tagFilter]);
  // The row can stay mounted while the thumbnail menu adds keywords.
  // Refresh on focus too, so the next search offers those new tags.
  useEffect(() => {
    void allKeywords().then(setKnownTags);
  }, []);
  const applyTag = async (term: string) => {
    const t = term.trim();
    if (!t) {
      dispatch({ type: "set_tag_filter", filter: null });
      return;
    }
    const ids = await imagesWithKeyword(t);
    dispatch({ type: "set_tag_filter", filter: { term: t, ids } });
  };
  // One list per seat: the popover and the browser's row can both be
  // mounted, and a datalist id has to be one element's.

  const group = (label: string, children: React.ReactNode) =>
    inline ? (
      <div key={label} role="group" aria-label={label} style={{ display: "flex", alignItems: "center", gap: 3, flex: "none" }}>
        {children}
      </div>
    ) : (
      <div key={label} style={{ marginBottom: 9 }}>
        <div className="kicker" style={{ fontSize: 8, marginBottom: 4 }}>{label}</div>
        {children}
      </div>
    );

  // In the row, the browser's button height (RIBBON_ICON_CHIP).
  const chipBox: React.CSSProperties = inline
    ? { height: 20, boxSizing: "border-box", padding: "0 7px", display: "inline-flex", alignItems: "center", flex: "none" }
    : { padding: "1px 7px", display: "inline-flex", alignItems: "center" };
  const toggle = (
    label: string,
    active: boolean,
    testid: string,
    hint: string,
    onClick: () => void
  ) => (
    <button
      key={testid}
      className="chip"
      data-testid={testid}
      data-active={active}
      data-hint={hint}
      style={{
        fontSize: 9, letterSpacing: ".06em",
        ...chipBox,
        color: active ? "var(--accent)" : "var(--text-ghost)",
        borderColor: active ? "var(--accent)" : "var(--line-4)",
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );

  const inputStyle = (lit: boolean): React.CSSProperties => ({
    boxSizing: "border-box", background: "var(--bg-app)",
    border: `1px solid ${lit ? "var(--accent)" : "var(--line-4)"}`, color: "var(--text-body)",
    fontSize: 10, outline: "none",
    ...(inline ? { width: 118, height: 20, padding: "0 5px" } : { width: "100%", padding: "3px 5px" }),
  });
  const note = (text: React.ReactNode, lit = false, testid?: string) => (
    <div data-testid={testid} style={{ fontSize: 8.5, color: lit ? "var(--accent)" : "var(--text-ghost)", marginTop: 2 }}>
      {text}
    </div>
  );

  const controls = (
    <>
      {group(
        "Name",
        <div style={inline ? { display: "contents" } : undefined}>
          <input
            type="text"
            value={state.filterName}
            placeholder={inline ? "Name, or IMG_43*" : "part of a name, or IMG_43*"}
            aria-label="Filter by name"
            data-testid="filter-name"
            data-hint="Type part of a name; * matches anything, ? one character"
            spellCheck={false}
            onChange={(e) => dispatch({ type: "set_filter_name", text: e.target.value })}
            style={inputStyle(false)}
          />
          {!inline && note("matches anywhere; * = anything, ? = one character")}
        </div>
      )}

      {group(
        "Tag",
        <div style={inline ? { display: "contents" } : undefined}>
          <SuggestField
            type="text"
            value={tagDraft}
            placeholder={inline ? "Tag" : "a keyword, like bride"}
            aria-label="Filter by tag"
            data-testid="filter-tag"
            data-hint="Show only photos carrying this keyword; Enter applies"
            suggestions={knownTags}
            onFocus={() => void allKeywords().then(setKnownTags)}
            spellCheck={false}
            onChange={setTagDraft}
            onKeyDown={(e) => {
              if (e.key === "Enter") void applyTag(tagDraft);
            }}
            onBlur={() => void applyTag(tagDraft)}
            style={inputStyle(!!state.tagFilter)}
          />
          {inline
            ? state.tagFilter && (
                <span data-testid="filter-tag-count" className="tnum" style={{ fontSize: 9, color: "var(--accent)" }}>
                  {state.tagFilter.ids.length}
                </span>
              )
            : note(
                state.tagFilter
                  ? `${state.tagFilter.ids.length} tagged "${state.tagFilter.term}"`
                  : "exact keyword; clear to show all",
                !!state.tagFilter,
                "filter-tag-count",
              )}
        </div>
      )}

      {group(
        "Rating",
        <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              data-testid={`filter-star-${n}`}
              data-active={n <= state.filterStars}
              aria-label={`${n} stars and up`}
              data-hint={`Show ${n} stars and up`}
              style={{ all: "unset", cursor: "pointer", padding: "0 1px", display: "inline-flex" }}
              onClick={() => dispatch({ type: "set_filter_stars", stars: n })}
            >
              <Star on={n <= state.filterStars} />
            </button>
          ))}
          <span style={{ fontSize: 9, color: "var(--text-ghost)", marginLeft: 4 }}>
            {state.filterStars > 0 ? `${state.filterStars}+` : "any"}
          </span>
        </div>
      )}

      {group(
        "Flags",
        (() => {
          // One button, three states (2026-09-15: "A single button with both
          // the symbols [√ X] when the user clicks on the button it cycles"):
          // off, only the picks (the check lit), the rejects hidden (the cross
          // lit). The two chips it replaces, PICKS and HIDE REJECTED, were two
          // seats for one question.
          const picks = state.filterPicksOnly && !state.filterHideRejected;
          const rejects = state.filterHideRejected && !state.filterPicksOnly;
          // The modifier inverts the context it is in, and red says so (The
          // report: "accents the X with red and shows the rejects. Do the
          // inverse with picks... changes the accent color and hides the
          // picks"): picks only or picks hidden, rejects hidden or rejects only.
          // Off has nothing to invert.
          const inverted = (picks || rejects) && state.filterFlagInverted;
          const stateName = picks ? (inverted ? "picks-hidden" : "picks") : rejects ? (inverted ? "rejects-only" : "rejects") : "off";
          const name = picks
            ? inverted ? "Picks hidden" : "Picks only"
            : rejects
              ? inverted ? "Rejects only" : "Rejects hidden"
              : "Picks and rejects: off";
          const lit = inverted ? "var(--reject)" : "var(--accent)";
          const alt = modLabel("alt");
          return (
            <button
              className="chip"
              data-testid="filter-flags"
              data-state={stateName}
              data-active={picks || rejects}
              aria-label={name}
              data-tip={name}
              data-hint={`Cycles: only the picks, then the rejects hidden, then everything. ${alt}-click inverts the one it is in: picks hidden, or only the rejects, in red`}
              style={{ ...chipBox, gap: 5, borderColor: picks || rejects ? lit : "var(--line-4)" }}
              onClick={(e) => dispatch({ type: e.altKey ? "invert_filter_flag" : "cycle_filter_flag" })}
            >
              <span data-testid="filter-flags-pick" data-on={picks} data-inverted={picks && inverted} style={{ display: "inline-flex", color: picks ? lit : "var(--text-ghost)" }}>
                <PickMark size={11} />
              </span>
              <span data-testid="filter-flags-reject" data-on={rejects} data-inverted={rejects && inverted} style={{ fontSize: 11, lineHeight: 1, color: rejects ? lit : "var(--text-ghost)" }}>
                ✖
              </span>
            </button>
          );
        })()
      )}

      {group(
        "Kind",
        <div style={{ display: "flex", gap: 3, flexWrap: inline ? undefined : "wrap" }}>
          {/* An icon where the MERGED label stood (2026-09-30: "swap the
'MERGED' label for an icon"): frames stacked into one, lit when
only the merges show.*/}
          <button
            className="chip"
            data-testid="filter-stacks"
            data-active={state.filterStacksOnly}
            aria-label="Merged"
            aria-pressed={state.filterStacksOnly}
            data-tip="Merged"
            data-hint="Merged: shows only stacks and panoramas; click again to show everything"
            style={{
              ...chipBox,
              color: state.filterStacksOnly ? "var(--accent)" : "var(--text-ghost)",
              borderColor: state.filterStacksOnly ? "var(--accent)" : "var(--line-4)",
            }}
            onClick={() => dispatch({ type: "toggle_filter_stacks" })}
          >
            <MergedIcon size={11} />
          </button>
          {(() => {
            // The thumbnails' edited glyph as the button ("Just a
            // button that is the Edit icon we see on thumbnails. When off, the
            // accent color is off. When on (edits) the accent color highlights"),
            // cycling like the flags: off, only the edited, then only the
            // untouched, which wears a strike through the glyph so the two lit
            // states read apart.
            const mode = state.filterEdited;
            const name = mode === "edited" ? "Edited only" : mode === "unedited" ? "Untouched only" : "Edited: off";
            return (
              <button
                className="chip"
                data-testid="filter-edited"
                data-state={mode}
                data-active={mode !== "all"}
                aria-label={name}
                data-tip={name}
                data-hint="Cycles: only the photos you have edited, then only the untouched, then everything"
                style={{ ...chipBox, position: "relative", borderColor: mode !== "all" ? "var(--accent)" : "var(--line-4)" }}
                onClick={() => dispatch({ type: "cycle_filter_edited" })}
              >
                <GroupGlyph size={11} color={mode === "all" ? "var(--text-ghost)" : "var(--accent)"} />
                {mode === "unedited" && (
                  <span
                    data-testid="filter-edited-strike"
                    style={{ position: "absolute", left: 5, right: 5, top: "50%", height: 1.5, background: "var(--accent)", transform: "rotate(-35deg)" }}
                  />
                )}
              </button>
            );
          })()}
        </div>
      )}

      {/* Two number fields reading "1 to any", typed or dragged, where two
sliders stood (2026-09-30: "the sliders take up extra room in the UI
especially at window scale 150%"); one component in both seats.*/}
      {group("Takes", <TakeRangeFields state={state} dispatch={dispatch} inline={inline} />)}

      {/* The shot-date range, the last row, one component in both seats
(2026-09-23); the fields say what they mean.*/}
      {group("Taken", <DateRangeFields state={state} dispatch={dispatch} inline={inline} />)}

      {inline ? (
        toggle("CLEAR ALL", false, "filter-clear", "Turn every filter off", () => dispatch({ type: "clear_filters" }))
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid var(--line-2)", paddingTop: 6 }}>
          <button
            className="chip"
            data-testid="filter-clear"
            data-hint="Turn every filter off"
            disabled={!on}
            style={{ fontSize: 9, padding: "2px 9px" }}
            onClick={() => dispatch({ type: "clear_filters" })}
          >
            CLEAR ALL
          </button>
        </div>
      )}
    </>
  );

  return inline ? (
    <div
      data-testid="catalog-filters"
      role="group"
      aria-label="Filters"
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", rowGap: 6 }}
    >
      {controls}
    </div>
  ) : (
    controls
  );
}


/** One label, whole rail clickable: the entire bar toggles the library.
 *
 * There was a chevron at the foot of it as well, which did exactly what
 * the rail above it already did. "Library also has an
 * expand arrow at the bottom that is redundant." Two controls for one
 * job is two places to look.*/
function TabRailImpl({ state, dispatch }: { state: State; dispatch: D }) {
  return (
    <div className="tabrail ui-zoom" data-testid="tabrail">
      <button
        className="railbar"
        data-testid="library-bar"
        aria-pressed={state.browserOpen}
        aria-label={state.browserOpen ? "Collapse library" : "Expand library"}
        data-hint={state.browserOpen ? "Fold the library away" : "Open the library"}
        data-hint-cmd="view.browser"
        onClick={() => dispatch({ type: "toggle_browser" })}
      >
        <span>LIBRARY</span>
      </button>
    </div>
  );
}

/** One folder-tree branch: chevron expands (lazy listing, no scan), name
 * opens (scans that folder). Parents and siblings stay visible while
 * descending, so deep archives navigate like a RAW editor's folder panel. */
function TreeRows({
  node, depth, activePath, dispatch, onOpen, onMenu, editedPaths, trashPaths,
}: {
  node: TreeNode; depth: number; activePath: string | null; dispatch: D;
  onOpen: (path: string) => void; onMenu: (x: number, y: number, path: string) => void;
  editedPaths: string[];
  trashPaths: string[];
}) {
  const active = activePath === node.path;
  const expandable = node.children === null || node.children.length > 0;
  return (
    <>
      <div
        data-testid={`tree-row-${node.path}`}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(e.clientX, e.clientY, node.path);
        }}
        style={{
          display: "flex", alignItems: "center", height: 22,
          padding: `0 12px 0 ${12 + depth * 12}px`, fontSize: 12,
          color: active ? "var(--accent)" : "var(--text-hi)",
          background: active ? "#202326" : "transparent",
        }}
      >
        {/* A drawn chevron, not a text glyph: at this size "▸" renders
            as a dot and stops signaling open vs closed. */}
        <button
          style={{ all: "unset", cursor: expandable ? "pointer" : "default", width: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)" }}
          data-testid={`tree-toggle-${node.path}`}
          aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
          aria-expanded={node.expanded}
          onClick={async () => {
            if (!expandable) return;
            if (node.children === null) {
              const children = await listSubfolders(node.path).catch(() => []);
              dispatch({ type: "set_tree_node", path: node.path, children, expanded: true });
            } else {
              dispatch({ type: "set_tree_node", path: node.path, expanded: !node.expanded });
            }
          }}
        >
          {expandable && (
            <svg
              width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
              style={{ transform: node.expanded ? "none" : "rotate(-90deg)" }}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          )}
        </button>
        <button
          // Its own color too, for the reason spelled out on the
          // collection name: an `all: unset` button does not reliably
          // inherit one in the webview this app ships in.
          style={{
            all: "unset", cursor: "pointer", flex: 1, display: "flex",
            alignItems: "center", gap: 6, overflow: "hidden",
            color: active ? "var(--accent)" : "var(--text-hi)",
          }}
          data-testid={`tree-open-${node.path}`}
          data-hint={node.path}
          onClick={() => onOpen(node.path)}
        >
          {/* The folder glyph opens with the branch: a second read of
              the same state, for rows where the chevron is easy to miss. */}
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={active ? "currentColor" : "#676b6e"} strokeWidth="1.8">
            {node.expanded ? (
              <path d="M2 19V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v2H7.5a2 2 0 0 0-1.9 1.4L2 19zm0 0a2 2 0 0 0 2 2h13.1a2 2 0 0 0 1.9-1.4L22 10" />
            ) : (
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            )}
          </svg>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{node.name}</span>
          {folderHasEdits(editedPaths, node.path) && <EditedBadge path={node.path} />}
          {trashPaths.includes(node.path) && <TrashBadge path={node.path} />}
        </button>
      </div>
      {node.expanded &&
        (node.children ?? []).map((c) => (
          <TreeRows key={c.path} node={c} depth={depth + 1} activePath={activePath} dispatch={dispatch} onOpen={onOpen} onMenu={onMenu} editedPaths={editedPaths} trashPaths={trashPaths} />
        ))}
    </>
  );
}

/** Collapsible section header for the library panel. */
function SectionHead({
  id, label, collapsed, onToggle, extra,
}: {
  id: string; label: string; collapsed: boolean; onToggle: () => void; extra?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px 6px" }}>
      <button
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}
        data-testid={`section-toggle-${id}`}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <svg
          width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2.6"
          style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="kicker">{label}</span>
      </button>
      {extra}
    </div>
  );
}

/** Recursively expands the subtree under `path`, breadth-first, capped so
 * a monster archive cannot flood the panel with directory listings. */
export async function expandAllChildren(path: string, dispatch: D): Promise<void> {
  const queue = [path];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const p = queue.shift()!;
    const children = await listSubfolders(p).catch(() => []);
    dispatch({ type: "set_tree_node", path: p, children, expanded: true });
    visited += 1;
    queue.push(...children.map((c) => c.path));
  }
}

function BrowserPanelImpl({ state, dispatch }: { state: State; dispatch: D }) {
  const [newCollectionName, setNewCollectionName] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  // Served view: what is on the network now, and the render progress
  // while a share is being prepared.
  const [serving, setServing] = useState<ServeStatus | null>(null);
  // Copy-the-link feedback: the icon turns into a checkmark for a beat.
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [servePrep, setServePrep] = useState<{ done: number; total: number } | null>(null);
  useEffect(() => {
    // A share survives panel remounts (it lives in the Rust side);
    // re-ask so the banner reflects reality after a mode switch.
    void serveStatus().then((s) => setServing(s));
  }, []);

  /** Renders every member through its own saved graph into the serve
   * directory (the export pipeline: metadata and ICC ride along), then
   * hands the finished files to the server. Snapshot semantics: the
   * share is as fresh as this moment, and refreshing means re-serving. */
  const serveCollection = async (id: number, name: string) => {
    const files = await loadCollection(id);
    const dir = await serveCacheDir();
    if (!dir || files.length === 0) return;
    setServePrep({ done: 0, total: files.length });
    const live = serializeGraph(state);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        // A saved graph is editor-shaped and must be serialized the
        // same way the live one is; raw, the engine rejects it unread.
        const saved = f.id === state.activeImage ? null : await loadGraph(f.id);
        const graph = saved ? serializeLoadedGraph(f.id, saved) : live;
        // 2048 on the long edge: a living-room screen's worth, and a
        // prerender pass that finishes before anyone loses interest.
        await exportTo(graph, f.id, `${dir}/${serveFileName(f.id)}`, {
          format: "webp",
          quality: 85,
          maxEdge: 2048,
          keepMetadata: true,
        });
      } catch (e) {
        logMsg("warn", `Serve: could not render ${f.name}: ${String(e)}`);
      }
      setServePrep({ done: i + 1, total: files.length });
    }
    const st = await serveStart(
      name,
      files.map((f) => ({ id: f.id, name: f.name })),
      dir,
      state.prefs.serveSimpleLink,
    );
    setServePrep(null);
    setServing(st);
    if (st) logMsg("info", `Serving "${st.name}" at ${st.url}`);
  };

  /** The classic web-gallery gesture: the collection as a static web gallery
   * in a folder of the user's choosing. index.html, thumbs/, img/,
   * relative paths, no server and no token: FTP it anywhere. Same
   * renders as a share, plus real thumbnails for the grid. */
  const exportGalleryCollection = async (id: number, name: string) => {
    const dir = await pickExportFolder();
    if (!dir) return;
    const files = await loadCollection(id);
    if (files.length === 0) return;
    setServePrep({ done: 0, total: files.length });
    const live = serializeGraph(state);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        // A saved graph is editor-shaped and must be serialized the
        // same way the live one is; raw, the engine rejects it unread.
        const saved = f.id === state.activeImage ? null : await loadGraph(f.id);
        const graph = saved ? serializeLoadedGraph(f.id, saved) : live;
        const base = serveFileName(f.id);
        await exportTo(graph, f.id, `${dir}/img/${base}`, {
          format: "webp",
          quality: 85,
          maxEdge: 2048,
          keepMetadata: true,
        });
        await exportTo(graph, f.id, `${dir}/thumbs/${base}`, {
          format: "webp",
          quality: 78,
          maxEdge: 480,
          keepMetadata: false,
        });
      } catch (e) {
        logMsg("warn", `Gallery: could not render ${f.name}: ${String(e)}`);
      }
      setServePrep({ done: i + 1, total: files.length });
    }
    await writeGallery(dir, name, files.map((f) => ({ id: f.id, name: f.name })));
    setServePrep(null);
    logMsg("info", `Web gallery "${name}" written to ${dir}: upload the folder as-is.`);
    // The folder opening IS the receipt: a feature whose only output is
    // a console line reads as a feature that did nothing.
    void revealFolder(dir).catch(() => {});
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // The seam's mousemove listener holds the closure it was mounted with
  // for the whole drag, and PanelDivider reports an increment since the
  // last move: read the size through a ref or every step adds its delta
  // to the same stale base and the tree never actually grows.
  const treeSizeRef = useRef(state.panelSizes.libraryTree);
  treeSizeRef.current = state.panelSizes.libraryTree;
  // Where "out of this collection" leads. See deselectCollection.
  const lastFolderRef = useRef<string | null>(null);
  if (state.activeFolderPath) lastFolderRef.current = state.activeFolderPath;
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const folderMenuRef = useDismiss<HTMLDivElement>(folderMenu !== null, () => setFolderMenu(null));
  // Catalog-known edited folders, plus a live check for the open folder so
  // the badge appears the moment an edit lands, before any refresh.
  // Ancestors light up via folderHasEdits, marking the trail down.
  const editedPaths = [...state.editedFolders];
  if (state.activeFolderPath && state.images.some((i) => i.edited)) {
    editedPaths.push(state.activeFolderPath);
  }
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  if (!state.browserOpen) return null;

  // Tree rows open exactly the row that was clicked; the shortlist rows
  // below re-pick a folder, which also brings back where work in it
  // stopped: the remembered subfolder opens and its image is selected.
  const openByPath = (path: string) => void openFolderPlain(path, state.folderTree, dispatch, state.prefs.thumbnailEdge);
  const repick = (path: string) => void openFolderRemembering(path, state.folderTree, dispatch, state.prefs.thumbnailEdge);

  // Clicking the empty part of the Collections list steps back out of
  // whichever collection is open. "If I click in the
  // Collections area off a collection it should deselect any selected
  // collection." A list you can get into needs a way out that is not
  // hunting for the row you are already on, and the empty space below the
  // rows is where the hand goes.
  //
  // The way out is the folder you were in, reopened, since a collection
  // replaced its listing on the way in. With no folder open there is
  // nothing to go back to, so the selection simply clears.
  const deselectCollection = (e: React.MouseEvent) => {
    // Only a click that landed on the section itself. A click that hit
    // a row, a button or the section head is that thing's business.
    if (e.target !== e.currentTarget) return;
    if (state.activeCollection === null) return;
    // The folder you were in, remembered on the way past: opening a
    // collection sets activeFolderPath to null (set_library, path:
    // null), so by the time anyone wants to step back out, the state
    // no longer knows where out was.
    const back = state.activeFolderPath ?? lastFolderRef.current;
    if (back) {
      void openFolderPlain(back, state.folderTree, dispatch, state.prefs.thumbnailEdge);
    } else {
      dispatch({ type: "set_library", label: state.libraryLabel, collection: null });
    }
  };

  const showCollection = async (id: number, label: string) => {
    // Takes the navigation token so a folder restore still in flight
    // cannot land its listing on top of the collection.
    beginNavigation();
    const files = await loadCollection(id);
    loadSessionImages(files, dispatch, state.prefs.thumbnailEdge);
    dispatch({ type: "set_library", label, collection: id, path: null });
  };

  return (
    <div className="panel-col ui-zoom" style={{ width: state.panelSizes.library }} data-testid="browser-panel">
      <div style={{ flex: "none", padding: "11px 12px 10px", borderBottom: "1px solid var(--line-1)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div className="kicker">Catalog</div>
          {/* Both of this panel's header buttons were hand-shrinking themselves
below chip size (9px in a 10px control), which left them reading as
captions rather than buttons and sitting a couple of pixels short of
every other button in the app. On the second of them: "the '+New'
button and font size is too small and not inline with other buttons
dimensions in the UI." Plain .chip for both, so they match each other
and everything else.*/}
          <button
            className="chip"
            data-testid="open-folder"
            aria-label="Open a folder of images"
            data-hint="Open a folder of images"
            onClick={() => void openFolderRemembering(undefined, state.folderTree, dispatch, state.prefs.thumbnailEdge)}
          >
            {/* An open folder rather than the word. Plain .chip still says how
big it is, same as +NEW beside it.*/}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" style={{ display: "block" }}>
              <path d="M3 19V5h6l2 2h10v3M3 19l3.2-8H22l-3 8z" />
            </svg>
          </button>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-strong)", marginTop: 4 }} data-testid="library-label">
          {state.libraryLabel}
        </div>
        <div className="tnum" style={{ fontSize: 10, color: "var(--text-faint)", marginTop: 2 }} data-testid="library-stats">
          {state.images.length} images · {state.collections.length} collection{state.collections.length === 1 ? "" : "s"}
        </div>
      </div>
      <div style={{ flex: "none", padding: "9px 0 7px", borderBottom: "1px solid var(--line-1)" }}>
        <SectionHead id="folders" label="Folders" collapsed={collapsed.has("folders")} onToggle={() => toggle("folders")} />
        {folderMenu && (
          <FixedMenu>
          <MenuSurface aria-label="Commands"
            ref={folderMenuRef}
            className="ctx-menu"
            data-testid="folder-menu"
            style={{ position: "fixed", left: folderMenu.x, top: folderMenu.y, width: 190 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              data-testid="folder-menu-expand"
              onClick={() => {
                void expandAllChildren(folderMenu.path, dispatch);
                setFolderMenu(null);
              }}
            >
              Expand all children
            </button>
            <button
              data-testid="folder-menu-collapse"
              onClick={() => {
                dispatch({ type: "collapse_tree_below", path: folderMenu.path });
                setFolderMenu(null);
              }}
            >
              Collapse all children
            </button>
            <div className="sep" />
            <button
              data-testid="folder-menu-reveal"
              onClick={() => {
                void revealFolder(folderMenu.path);
                setFolderMenu(null);
              }}
            >
              Show in system browser
            </button>
            <div className="sep" />
            {/* Two ways off the list (2026-09-08). Hide keeps every record and asks
only when there are photographs under the folder; Flush forgets the
catalog's records and asks twice. Neither touches a file, and the
edits live outside the catalog either way. The count is fetched before
the prompt so the user is told a number, not asked to agree to an
unknown; catalogui.tsx is loaded on the click, since it imports this
file.*/}
            <button
              data-testid="folder-menu-hide"
              data-hint="Take this folder and its subfolders off the list. Nothing is deleted or forgotten; opening the folder again brings it back"
              onClick={() => {
                const path = folderMenu.path;
                setFolderMenu(null);
                void folderSubtreeCounts(path).then(async (c) => {
                  if (c.images === 0) {
                    const { leaveFolder } = await import("./catalogui");
                    await leaveFolder("hide", path, dispatch);
                    flashStatus("Folder hidden. Nothing was deleted; open it again to bring it back.");
                    return;
                  }
                  dispatch({ type: "ask_confirm", action: { kind: "hide_folder", path, folders: c.folders, images: c.images } });
                }).catch((e) => logMsg("error", `Could not hide the folder: ${String(e)}`));
              }}
            >
              Hide folder
            </button>
            <button
              data-testid="folder-menu-flush"
              data-hint="Forget the catalog's records for this folder and its subfolders: ratings, flags, keywords, collections. No file is touched and the edits are kept"
              onClick={() => {
                const path = folderMenu.path;
                setFolderMenu(null);
                void folderSubtreeCounts(path).then((c) => {
                  dispatch({ type: "ask_confirm", action: { kind: "flush_folder", path, folders: c.folders, images: c.images } });
                }).catch((e) => logMsg("error", `Could not read the folder: ${String(e)}`));
              }}
            >
              Flush folder…
            </button>
            {/* "if a folder has a .trash in it then in the context menu
for folders have an option to open the trash folder in the system
browser." Better than a Trash view inside the app, and consistent with
the rule the folder already lives by: nothing here empties it, so the
app's job ends at showing you where it is. Taking things back out is
the file browser's job too, and the next scan notices.*/}
            {state.foldersWithTrash.includes(folderMenu.path) && (
              <button
                data-testid="folder-menu-trash"
                data-hint="Open this folder's .trash in the file browser. Heeler never empties it"
                onClick={() => {
                  const path = folderMenu.path;
                  setFolderMenu(null);
                  void revealTrash(path).catch((e) =>
                    logMsg("error", `Could not open the trash: ${String(e)}`),
                  );
                }}
              >
                Show Trash in system browser
              </button>
            )}
            {/* Only where it would do something. The count comes from
                the catalog before the dialog opens, so the user is told
                a number rather than asked to agree to an unknown. */}
            {state.foldersWithHidden.includes(folderMenu.path) && (
              <button
                data-testid="folder-menu-recover"
                data-hint="Bring back photographs hidden from this folder"
                onClick={() => {
                  const path = folderMenu.path;
                  setFolderMenu(null);
                  void hiddenInFolder(path).then((count) => {
                    if (count > 0) {
                      dispatch({ type: "ask_confirm", action: { kind: "recover_hidden", path, count } });
                    }
                  });
                }}
              >
                Recover Hidden…
              </button>
            )}
          </MenuSurface>
          </FixedMenu>
        )}
        {!collapsed.has("folders") && (
          <>
        {state.folders.length === 0 && (
          <div style={{ padding: "0 12px 4px", fontSize: 10, color: "var(--text-ghost)" }}>
            Folders you open with the folder button appear here.
          </div>
        )}
        {/* The opened-folder shortlist grows too, one row per folder
            ever opened, and pinning Collections is worth nothing if this
            list can still walk it off the bottom. A cap rather than a
            height, unlike the tree below: this list is normally three or
            four rows and should not reserve space it is not using, and
            nobody needs to drag it. */}
        <div style={{ maxHeight: 132, overflowY: "auto" }} data-testid="folder-shortlist-scroll">
        {state.folders.map((f) => (
          <button
            key={f.id}
            data-testid={`folder-row-${f.id}`}
            data-hint={f.path}
            onClick={() => repick(f.path)}
            // The same menu the tree rows carry: the owner asked for Hide and
            // Flush on "Library > Folders", which is this list, and a root
            // browsed into by mistake is the case it is for.
            onContextMenu={(e) => {
              e.preventDefault();
              setFolderMenu({ x: e.clientX, y: e.clientY, path: f.path });
            }}
            style={{
              all: "unset", cursor: "pointer", boxSizing: "border-box", width: "100%",
              display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center",
              height: 24, padding: "0 12px", fontSize: 12,
              // The folder you are in, named in the color the app uses
              // for "this one is live", the same as the collection
              // below it. White lettering said "selected" in a language
              // nothing else in this panel speaks.
              color: state.libraryLabel === f.name && state.activeCollection === null ? "var(--accent)" : "var(--text-hi)",
              background: state.libraryLabel === f.name && state.activeCollection === null ? "#202326" : "transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, overflow: "hidden" }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" opacity={0.85}>
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.name}</span>
              {folderHasEdits(editedPaths, f.path) && <EditedBadge path={f.path} />}
              {state.foldersWithTrash.includes(f.path) && <TrashBadge path={f.path} />}
            </div>
            <div className="tnum" style={{ fontSize: 10, color: "var(--text-ghost)" }}>{f.count}</div>
          </button>
        ))}
        </div>
        {state.folderTree && (
          <>
            <div className="kicker" style={{ padding: "7px 12px 4px", fontSize: 8 }}>
              Tree
            </div>
            {/* A height of its own, dragged by the seam below, and the
                tree scrolls inside it.

"The position of Collections should not move based on the
size of TREE above it. TREE should be scrollable when the folders
clipped. The user should be able to manually resize Collections as they
see fit."

                The old cap was 45vh, which sounds like the same thing
                and is not: a cap only holds once the tree has already
                grown past it, so every expansion below that walked
                Collections down the panel. A height holds from the
                first row, and one number covers both sections, since
                Collections takes whatever is left. */}
            <div
              style={{ height: state.panelSizes.libraryTree, overflowY: "auto" }}
              data-testid="folder-tree-scroll"
            >
              <TreeRows
                node={state.folderTree}
                depth={0}
                activePath={state.activeCollection === null ? state.activeFolderPath : null}
                dispatch={dispatch}
                onOpen={openByPath}
                onMenu={(x, y, path) => setFolderMenu({ x, y, path })}
                editedPaths={editedPaths}
                trashPaths={state.foldersWithTrash}
              />
            </div>
          </>
        )}
          </>
        )}
      </div>
      {/* The seam that sets the split. Only where there is a tree to
          size: with Folders collapsed, or before a folder has been
          opened, Collections already has the whole panel and there is
          nothing to drag. */}
      {state.folderTree && !collapsed.has("folders") && (
        <PanelDivider
          vertical={false}
          testid="divider-library-tree"
          onDelta={(d) =>
            dispatch({
              type: "set_panel_size",
              panel: "libraryTree",
              size: treeSizeRef.current + d,
            })
          }
        />
      )}
      {/* Whatever is left of the panel, and its own scrollbar when the
          collections outrun it. */}
      <div
        data-testid="collections-section"
        onClick={deselectCollection}
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "9px 0 8px", borderBottom: "1px solid var(--line-1)" }}
      >
        <SectionHead
          id="collections"
          label="Collections"
          collapsed={collapsed.has("collections")}
          onToggle={() => toggle("collections")}
          extra={
            <button
              className="chip"
              data-testid="new-collection"
              aria-label="Create a collection"
              data-hint="Create a collection"
              onClick={() => setNewCollectionName(newCollectionName === null ? "" : null)}
            >
              {/* A stack of cards with a plus: a collection is a set you put together
(an icon rather than "+ New"). Plain .chip, the same as
the folder button beside it.*/}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false" style={{ display: "block" }}>
                <path d="M3 9h12v12H3zM7 5h12v12M17 3v6M14 6h6" />
              </svg>
            </button>
          }
        />
        {!collapsed.has("collections") && (
          <>
        {newCollectionName !== null && (
          <div style={{ padding: "0 12px 6px" }}>
            <input
              autoFocus
              value={newCollectionName}
              data-testid="new-collection-name"
              placeholder="Collection name"
              onChange={(e) => setNewCollectionName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === "Enter" && newCollectionName.trim()) {
                  // A taken name is refused by the catalog; without the
                  // catch that refusal was an unhandled rejection and the
                  // field just sat there, saying nothing.
                  try {
                    await createCollection(newCollectionName.trim());
                    setNewCollectionName(null);
                    void refreshLibrary(dispatch);
                  } catch (err) {
                    logMsg("error", String(err));
                  }
                }
                if (e.key === "Escape") setNewCollectionName(null);
              }}
              style={{
                width: "100%", boxSizing: "border-box", background: "var(--bg-app)",
                border: "1px solid var(--line-4)", color: "var(--text-body)",
                fontSize: 11, padding: "3px 6px", outline: "none",
                borderRadius: "var(--radius-btn)",
              }}
            />
          </div>
        )}
        {serving && (
          <div
            data-testid="serve-banner"
            style={{
              margin: "0 12px 6px", padding: "5px 7px", fontSize: 10, lineHeight: 1.5,
              border: "1px solid var(--accent-dim)", background: "#151f24", color: "var(--text-body)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ color: "var(--accent)", letterSpacing: ".06em" }}>
                SERVING · {serving.name}
              </span>
              <span style={{ display: "flex", gap: 4 }}>
                <button
                  className="chip"
                  data-testid="serve-copy"
                  aria-label="Copy the share link"
                  data-hint="Copy the share link, ready to paste to whoever is viewing"
                  style={{ fontSize: 9, padding: "1px 7px", color: copiedUrl ? "var(--accent)" : undefined }}
                  onClick={() => {
                    void navigator.clipboard?.writeText(serving.url);
                    setCopiedUrl(true);
                    window.setTimeout(() => setCopiedUrl(false), 1200);
                  }}
                >
                  {copiedUrl ? (
                    // Copied: a checkmark, briefly.
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden focusable="false">
                      <path d="M3 8.5l3.5 3.5L13 4" />
                    </svg>
                  ) : (
                    // Two pages: the copy everyone knows.
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden focusable="false">
                      <rect x="5.5" y="5.5" width="8" height="8" />
                      <path d="M10.5 5.5v-3h-8v8h3" />
                    </svg>
                  )}
                </button>
                <button
                  className="chip"
                  data-testid="serve-live"
                  data-active={state.serveLive || undefined}
                  aria-label="Live share"
                  data-hint="LIVE: re-render into the share as you edit; /live shows the active photo full screen"
                  style={{
                    fontSize: 9, padding: "1px 7px",
                    color: state.serveLive ? "var(--accent)" : undefined,
                    borderColor: state.serveLive ? "var(--accent-dim)" : undefined,
                  }}
                  onClick={() => dispatch({ type: "toggle_serve_live" })}
                >
                  {/* Broadcast waves: live. */}
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden focusable="false">
                    <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
                    <path d="M5.2 10.8a4 4 0 010-5.6M10.8 5.2a4 4 0 010 5.6" />
                    <path d="M3.2 12.8a6.8 6.8 0 010-9.6M12.8 3.2a6.8 6.8 0 010 9.6" />
                  </svg>
                </button>
                <button
                  className="chip"
                  data-testid="serve-stop"
                  aria-label="Stop sharing"
                  data-hint="Stop sharing: the link goes dead until you serve again"
                  style={{ fontSize: 9, padding: "1px 7px" }}
                  onClick={() => {
                    void serveStop();
                    setServing(null);
                  }}
                >
                  {/* A stop square. */}
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden focusable="false">
                    <rect x="4" y="4" width="8" height="8" />
                  </svg>
                </button>
              </span>
            </div>
            <div className="tnum" data-testid="serve-url" style={{ wordBreak: "break-all", color: "var(--text-faint)" }}>
              {serving.url}
            </div>
            <div style={{ color: "var(--text-ghost)" }}>
              {serving.count} photos, view only. Anyone on your network with this link can see them.
              {state.serveLive && " Live: edits re-render into the share; add /live to the link for the proofing view."}
            </div>
          </div>
        )}
        {servePrep && (
          <div data-testid="serve-progress" style={{ padding: "0 12px 6px", fontSize: 10, color: "var(--text-ghost)" }}>
            Preparing share… {servePrep.done}/{servePrep.total}
          </div>
        )}
        {state.collections.length === 0 && newCollectionName === null && (
          <div style={{ padding: "0 12px 4px", fontSize: 10, color: "var(--text-ghost)" }}>
            No collections yet.
          </div>
        )}
        {state.collections.map((c) => {
          const active = state.activeCollection === c.id;
          return (
            <div
              key={c.id}
              data-testid={`collection-row-${c.id}`}
              style={{
                display: "grid", gridTemplateColumns: "1fr auto auto auto", alignItems: "center",
                gap: 7, height: 27, padding: "0 12px", fontSize: 12,
                // White, and white means white. The owner, twice: "Deselected
                // /Unselected Collections should keep the white font they had before",
                // then "I said to make the names of unselected collections white. They
                // are still dark." It had been --text-body, which measures near-white
                // on a chart and evidently does not read as white on a screen. Every
                // row in this panel now follows one rule: white unless it is the one
                // you are in, and then the accent. Nothing in between left to argue
                // about.
                color: active ? "var(--accent)" : "var(--text-hi)",
                background: active ? "#202326" : "transparent",
              }}
            >
              {renaming?.id === c.id ? (
                <input
                  autoFocus
                  value={renaming.name}
                  data-testid="rename-collection-name"
                  onChange={(e) => setRenaming({ id: c.id, name: e.target.value })}
                  onKeyDown={async (e) => {
                    if (e.key === "Enter" && renaming.name.trim()) {
                      // Same refusal story as New: renaming onto a taken
                      // name must say so, not die as an unhandled
                      // rejection.
                      try {
                        await renameCollection(c.id, renaming.name.trim());
                        setRenaming(null);
                        void refreshLibrary(dispatch);
                      } catch (err) {
                        logMsg("error", String(err));
                      }
                    }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  style={{
                    background: "var(--bg-app)", border: "1px solid var(--line-4)",
                    color: "var(--text-body)", fontSize: 11, padding: "1px 4px",
                    outline: "none", minWidth: 0, borderRadius: "var(--radius-btn)",
                  }}
                />
              ) : (
                <button
                  style={{
                    all: "unset", cursor: "pointer", overflow: "hidden",
                    textOverflow: "ellipsis", whiteSpace: "nowrap",
                    // Its OWN color, never the row's.
                    //
                    // This is why the name stayed dark through three
                    // goes at fixing it. `undefined` here left the
                    // button inheriting, and `all: unset` is supposed
                    // to leave an inherited property inheriting: in the
                    // browser build it does, which is where every check
                    // was made, and the measurements came back white.
                    // WKWebView, which is what the app actually runs
                    // in, resolves the button back to its own color
                    // instead, so the row said white and the lettering
                    // ignored it. theme.css already carries one note
                    // about WKWebView disagreeing over an inherited
                    // property (user-select); this is the second, and
                    // the lesson is the same: say it here rather than
                    // hope it arrives from above.
                    color: active ? "var(--accent)" : "var(--text-hi)",
                  }}
                  data-testid={`collection-open-${c.id}`}
                  data-hint="Show this collection (double-click renames)"
                  onClick={() => void showCollection(c.id, c.name)}
                  onDoubleClick={() => setRenaming({ id: c.id, name: c.name })}
                >
                  {c.name}
                </button>
              )}
              {c.hasLook && (
                <div style={{ display: "flex", alignItems: "center", gap: 3, border: "1px solid var(--accent-dim)", background: "#18242c", padding: "1px 4px", borderRadius: "var(--radius-btn)" }}>
                  <GroupGlyph size={11} />
                  <span style={{ fontSize: 10, color: "var(--accent)", letterSpacing: ".05em" }}>LOOK</span>
                </div>
              )}
              <button
                className="rowbtn"
                style={{ fontSize: 15, lineHeight: 1 }}
                data-testid={active ? `collection-remove-${c.id}` : `collection-add-${c.id}`}
                aria-label={active ? "Remove active image from collection" : "Add active image to collection"}
                data-hint={active ? "Remove the active image from this collection" : "Add the active image to this collection"}
                onClick={async () => {
                  const img = state.images.find((i) => i.id === state.activeImage);
                  if (active) {
                    await removeFromCollection(c.id, state.activeImage);
                    await showCollection(c.id, c.name);
                  } else {
                    await addToCollection(c.id, state.activeImage, img?.name);
                  }
                  void refreshLibrary(dispatch);
                }}
              >
                {active ? "−" : "+"}
              </button>
              {/* "increase the size of the icons in the collection row for
readability." They were 10px pictures of a radio mast and a globe,
which at that size are the same smudge; 13 is where the two come
apart. The row grew to 27 to carry them, and the gaps with it, since a
wall of bigger glyphs jammed together is not more readable.*/}
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="tnum" style={{ fontSize: 11, color: "var(--text-dim)" }}>{c.count}</span>
                {(
                  <button
                    className="rowbtn"
                    data-testid={`collection-serve-${c.id}`}
                    aria-label={`Serve ${c.name} on the local network`}
                    data-hint="Serve this collection as a view-only gallery on your network"
                    onClick={() => void serveCollection(c.id, c.name)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="2" />
                      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
                    </svg>
                  </button>
                )}
                <button
                  className="rowbtn"
                  data-testid={`collection-gallery-${c.id}`}
                  aria-label={`Export ${c.name} as a web gallery`}
                  data-hint="Write this collection as a static web gallery: a folder ready to upload to any site"
                  onClick={() => void exportGalleryCollection(c.id, c.name)}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
                  </svg>
                </button>
                <button
                  className="rowbtn"
                  style={{ fontSize: 12, lineHeight: 1 }}
                  data-testid={`collection-delete-${c.id}`}
                  aria-label={`Delete collection ${c.name}`}
                  data-hint="Delete this collection (images stay in the catalog)"
                  onClick={async () => {
                    await deleteCollection(c.id);
                    if (active) dispatch({ type: "set_library", label: state.libraryLabel, collection: null });
                    void refreshLibrary(dispatch);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
          </>
        )}
      </div>
    </div>
  );
}

/** The Tags submenu's insides: what the photos carry now, each with an
 * X to take it off, then an input to type a new term and the terms the
 * catalog already knows. The menu stays open through it all, so a
 * pass over several tags is one visit, not five. Adds skip photos
 * already carrying the tag; removals touch only the ones that do. */
function TagMenu({ ids, dispatch }: { ids: string[]; dispatch: D }) {
  const [known, setKnown] = useState<string[]>([]);
  const [current, setCurrent] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const key = ids.join(",");
  const reload = async () => {
    const per = await Promise.all(ids.map((id) => imageKeywords(id)));
    // The union across the selection: a tag on any of the photos shows,
    // and its X clears it from all of them.
    const union: string[] = [];
    for (const list of per) {
      for (const k of list) {
        if (!union.some((u) => u.toLowerCase() === k.toLowerCase())) union.push(k);
      }
    }
    setCurrent(union);
    setKnown(await allKeywords());
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const add = (raw: string) => {
    const kw = raw.trim();
    if (!kw) return;
    setDraft("");
    void (async () => {
      for (const id of ids) {
        const has = await imageKeywords(id);
        if (!has.some((k) => k.toLowerCase() === kw.toLowerCase())) {
          await setImageKeywords(id, [...has, kw]);
        }
      }
      logMsg("info", `Tagged ${ids.length} photo${ids.length === 1 ? "" : "s"} with "${kw}"`);
      await reload();
      // The library panel lists keywords; a brand-new one should appear.
      void refreshLibrary(dispatch);
    })();
  };
  const remove = (kw: string) => {
    void (async () => {
      for (const id of ids) {
        const has = await imageKeywords(id);
        const next = has.filter((k) => k.toLowerCase() !== kw.toLowerCase());
        if (next.length !== has.length) await setImageKeywords(id, next);
      }
      logMsg("info", `Removed "${kw}" from ${ids.length} photo${ids.length === 1 ? "" : "s"}`);
      await reload();
      void refreshLibrary(dispatch);
    })();
  };
  const matches = known
    .filter((k) => !current.some((c) => c.toLowerCase() === k.toLowerCase()))
    .filter((k) => k.toLowerCase().includes(draft.trim().toLowerCase()))
    .slice(0, 7);
  return (
    <div style={{ width: 150 }}>
      {current.map((k) => (
        <div
          key={k}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "2px 9px" }}
        >
          <span
            style={{
              fontSize: 10, color: "var(--accent)", overflow: "hidden",
              textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}
          >
            {k}
          </span>
          <button
            style={{ all: "unset", cursor: "pointer", color: "var(--text-ghost)", fontSize: 10, padding: "0 2px" }}
            aria-label={`Remove tag ${k}`}
            data-testid={`thumb-menu-tag-remove-${k}`}
            onClick={() => remove(k)}
          >
            ✕
          </button>
        </div>
      ))}
      {current.length > 0 && <div className="sep" />}
      <div style={{ padding: "3px 9px" }}>
        <input
          data-testid="thumb-menu-tag-input"
          placeholder="New or existing tag"
          value={draft}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") add(draft);
          }}
          style={{
            width: "100%", boxSizing: "border-box", background: "var(--bg-app)",
            border: "1px solid var(--line-4)", color: "var(--text-body)",
            fontSize: 10, padding: "2px 5px", outline: "none",
          }}
        />
      </div>
      {matches.map((k) => (
        <button key={k} data-testid={`thumb-menu-tag-${k}`} onClick={() => add(k)}>
          {k}
        </button>
      ))}
    </div>
  );
}

/** The right-click menu on a photograph, shared by the filmstrip and
 * the expanded catalog's grid and table. Every action follows one
 * selection rule: a click inside a multi-selection acts on all of it,
 * outside it on the clicked photo alone. */
function ThumbMenu({
  state,
  dispatch,
  thumbMenu,
  setThumbMenu,
}: {
  state: State;
  dispatch: D;
  thumbMenu: { x: number; y: number; id: string };
  setThumbMenu: (v: null) => void;
}) {
  const thumbMenuRef = useDismiss<HTMLDivElement>(true, () => setThumbMenu(null));
  // Where the menu actually fits, measured rather than guessed.
  //
  // This clamped against a hardcoded 320px, which was true of the menu
  // the day it was written and has drifted every time an entry was
  // added since; the surplus hung off the bottom of the window. The
  // report: "The context menu when right clicking a thumbnail gets cut
  // off by the main window the vertical position of the thumbnail is
  // too low." Measuring in a layout effect (before paint, so nothing
  // jumps) means the number cannot go stale again, and the cap below
  // means even a menu taller than the window scrolls instead of losing
  // its tail.
  const [box, setBox] = useState<{ x: number; y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = thumbMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const h = rect.height || 320;
    const at = clampMenu(thumbMenu, { w: rect.width || 170, h }, viewportSize());
    setBox({ ...at, h });
  }, [thumbMenu.x, thumbMenu.y, thumbMenu.id]);
  const view = viewportSize();
  const placed = box ?? clampMenu(thumbMenu, { w: 170, h: 320 }, view);
  // Scroll only when the menu genuinely cannot fit under its own top
  // edge: measured height against the room actually left below it.
  const tall = !!box && box.h > view.h - placed.y - 12;
  return (
    <FixedMenu>
        <MenuSurface aria-label="Commands"
          ref={thumbMenuRef}
          className="ctx-menu"
          data-testid="thumb-menu"
          style={{
            position: "fixed",
            width: 170,
            left: placed.x,
            top: placed.y,
            // A menu longer than the window scrolls rather than running
            // off it. Overflow stays visible until it has to be: a
            // submenu opens beside its parent, and clipping those would
            // be a worse fault than the one this fixes.
            maxHeight: view.h - 12,
            overflowY: tall ? "auto" : "visible",
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            data-testid="thumb-menu-reset"
            onClick={() => {
              // The aftermath (on-disk graph, catalog badge, thumbnail re-render)
              // drains from resetPending (ResetAftermath), the same as every other
              // reset door. A right-click inside a multi-selection resets the whole
              // selection; outside it, just the clicked photo (the queue add's rule).
              // One command, so one Undo takes it all back, even while another
              // photograph is open.
              const ids = state.imageSelection.includes(thumbMenu.id)
                ? state.imageSelection
                : [thumbMenu.id];
              dispatch({ type: "reset_image_edits", ids });
              setThumbMenu(null);
            }}
          >
            Reset all edits
          </button>
          <div className="sep" />
          <button
            data-testid="thumb-menu-export-queue"
            data-hint="Queue for export in the Export panel's active batch group"
            onClick={() => {
              // A right-click inside a multi-selection queues the whole
              // selection; outside it, just the clicked photo. Same rule
              // every tag and merge above follows.
              const ids = state.imageSelection.includes(thumbMenu.id)
                ? state.imageSelection
                : [thumbMenu.id];
              setThumbMenu(null);
              dispatch({ type: "export_queue_add", ids });
              if (!state.exportOpen) dispatch({ type: "toggle_export" });
            }}
          >
            Add to Export Queue
          </button>
          <button
            data-testid="thumb-menu-quick-export"
            data-hint="Straight to a folder you pick, no queue; uses the active batch's settings"
            onClick={() => {
              // Same selection rule as the queue add: inside a
              // multi-selection exports all of it, outside just this one.
              const scoped = state.imageSelection.includes(thumbMenu.id)
                ? state
                : { ...state, imageSelection: [thumbMenu.id], activeImage: thumbMenu.id };
              void quickExport(scoped);
              setThumbMenu(null);
            }}
          >
            Quick Export…
          </button>
          <div className="sep" />
          {(() => {
            const col = state.collections.find((c) => c.id === state.activeCollection);
            const ids = state.imageSelection.includes(thumbMenu.id)
              ? state.imageSelection
              : [thumbMenu.id];
            return (
              <>
                <span data-hint={col ? `Add to the selected collection, "${col.name}"` : "Select a collection in the library panel first"} style={{ display: "inline-flex" }}><button
                  data-testid="thumb-menu-collection-add"
                  data-hint={col ? `Add to the selected collection, "${col.name}"` : "Select a collection in the library panel first"}
                  disabled={!col}
                  onClick={() => {
                    void editCollectionMembership(state, dispatch, ids, "add");
                    setThumbMenu(null);
                  }}
                >
                  {col ? `Add to "${col.name}"` : "Add to Collection"}
                </button></span>
                <span data-hint={col ? `Take out of "${col.name}"; the photo stays in the catalog` : "Select a collection in the library panel first"} style={{ display: "inline-flex" }}><button
                  data-testid="thumb-menu-collection-remove"
                  data-hint={col ? `Take out of "${col.name}"; the photo stays in the catalog` : "Select a collection in the library panel first"}
                  disabled={!col}
                  onClick={() => {
                    void editCollectionMembership(state, dispatch, ids, "remove");
                    setThumbMenu(null);
                  }}
                >
                  {col ? `Remove from "${col.name}"` : "Remove from Collection"}
                </button></span>
                <span data-hint="Take out of every collection at once; the photo stays in the catalog" style={{ display: "flex" }}><button
                  data-testid="thumb-menu-collection-remove-all"
                  data-hint="Take out of every collection at once; the photo stays in the catalog"
                  disabled={state.collections.length === 0}
                  onClick={() => {
                    void editCollectionMembership(state, dispatch, ids, "remove-all");
                    setThumbMenu(null);
                  }}
                >
                  Remove from All Collections
                </button></span>
              </>
            );
          })()}
          <div className="sep" />
          <button
            data-testid="thumb-menu-copy-edits"
            data-hint="Carry this photo's whole edit, ready to paste onto others"
            onClick={() => {
              void copyEditsFrom(state, dispatch, thumbMenu.id).then((ok) => {
                if (!ok) logMsg("warn", "Nothing to copy: that photo has no edits yet");
              });
              setThumbMenu(null);
            }}
          >
            Copy Edits
          </button>
          <span data-hint={
              state.editClipboard
                ? `Apply the copied edit (from ${state.editClipboard.sourceName})`
                : "Copy edits from a photo first"
            } style={{ display: "flex" }}><button
            data-testid="thumb-menu-paste-edits"
            data-hint={
              state.editClipboard
                ? `Apply the copied edit (from ${state.editClipboard.sourceName})`
                : "Copy edits from a photo first"
            }
            disabled={!state.editClipboard}
            onClick={() => {
              // Same selection rule as every action above: inside the
              // selection pastes onto all of it, outside onto the one.
              const ids = state.imageSelection.includes(thumbMenu.id)
                ? state.imageSelection
                : [thumbMenu.id];
              void pasteEditsTo(state, dispatch, ids).then((n) => {
                if (n > 0) logMsg("info", `Pasted edits onto ${n} photo${n === 1 ? "" : "s"}`);
              });
              setThumbMenu(null);
            }}
          >
            Paste Edits
          </button></span>
          {/* The wrapper's hint is the one a grayed row shows, so it has to say WHY
it is gray: too many selected as well as too few ("if
there are too many selected photos then the status line should say as
much").*/}
          <span
            data-hint={
              state.imageSelection.length > 4
                ? `That is ${state.imageSelection.length} photographs; Edit Together takes two to four. Narrow the selection down.`
                : !state.imageSelection.includes(thumbMenu.id) || state.imageSelection.length < 2
                  ? "Edit the selected photos together; select two to four photographs first, this one among them"
                  : "Edit the selected photos together, this many at once"
            }
            style={{ display: "flex" }}
          ><button
            data-testid="thumb-menu-quad"
            disabled={
              !state.imageSelection.includes(thumbMenu.id) ||
              state.imageSelection.length < 2 ||
              state.imageSelection.length > 4
            }
            onClick={() => {
              void openQuadEdit(state, dispatch, state.imageSelection);
              setThumbMenu(null);
            }}
          >
            Edit Together
          </button></span>
          <span data-hint={state.imageSelection.includes(thumbMenu.id) ? linkHint(state, state.imageSelection).hint : "Link the selected photographs so an edit to any one lands on the others; select two or more first, this one among them"} style={{ display: "flex" }}><button
            data-testid="thumb-menu-link"
            disabled={!state.imageSelection.includes(thumbMenu.id) || linkHint(state, state.imageSelection).disabled}
            onClick={() => {
              void linkPhotos(state, dispatch, state.imageSelection);
              setThumbMenu(null);
            }}
            style={{ display: "flex", alignItems: "center", gap: 7 }}
          >
            <LinkIcon />
            Link Selected
          </button></span>
          {state.images.find((i) => i.id === thumbMenu.id)?.linkGroup && (
            <>
              <span data-hint="Select every photograph in this one's link, to see or act on them together" style={{ display: "flex" }}><button
                data-testid="thumb-menu-select-linked"
                onClick={() => {
                  const group = state.images.find((i) => i.id === thumbMenu.id)?.linkGroup;
                  dispatch({ type: "select_images", ids: state.images.filter((i) => i.linkGroup === group).map((i) => i.id) });
                  setThumbMenu(null);
                }}
                style={{ display: "flex", alignItems: "center", gap: 7 }}
              >
                <LinkIcon />
                Select Linked
              </button></span>
              <span data-hint="Copy this photograph's edit onto every other photograph in its link; overrides hold, pinned ones sit it out" style={{ display: "flex" }}><button
                data-testid="thumb-menu-link-match"
                onClick={() => {
                  dispatch({ type: "link_match", id: thumbMenu.id });
                  setThumbMenu(null);
                }}
                style={{ display: "flex", alignItems: "center", gap: 7 }}
              >
                <LinkIcon />
                Match to This Photo
              </button></span>
              <span data-hint="Take this photograph (or the whole selection) out of its link; the rest stay linked" style={{ display: "flex" }}><button
                data-testid="thumb-menu-unlink"
                onClick={() => {
                  const ids = state.imageSelection.includes(thumbMenu.id) ? state.imageSelection : [thumbMenu.id];
                  void unlinkPhotos(state, dispatch, ids);
                  setThumbMenu(null);
                }}
                style={{ display: "flex", alignItems: "center", gap: 7 }}
              >
                <LinkIcon />
                Unlink
              </button></span>
              <span data-hint={state.linkPinned.includes(thumbMenu.id) ? "Let this photograph take the link's edits again" : "Keep this photograph in the link but let edits pass it by, for this session"} style={{ display: "flex" }}><button
                data-testid="thumb-menu-link-pin"
                onClick={() => {
                  dispatch({ type: "toggle_link_pin", id: thumbMenu.id });
                  setThumbMenu(null);
                }}
                style={{ display: "flex", alignItems: "center", gap: 7 }}
              >
                <LinkIcon />
                {state.linkPinned.includes(thumbMenu.id) ? "Unpin from Link" : "Pin out of Link"}
              </button></span>
            </>
          )}
          <div className="sep" />
          {/* The same tagging the Photo menu offers, where the photos
              are. Right-clicking a thumbnail is how most people reach
              for a rating. */}
          <SubMenu label="Rating" testid="thumb-menu-rating">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                data-testid={`thumb-menu-rating-${n}`}
                onClick={() => {
                  rateSelection(state, dispatch, n);
                  setThumbMenu(null);
                }}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}
              >
                <span>
                  {n} Star{n === 1 ? "" : "s"}
                </span>
                <MenuKey binding={bindingFor(`rate.${n}`, state.prefs.hotkeys)} />
              </button>
            ))}
            <button
              data-testid="thumb-menu-rating-0"
              onClick={() => {
                rateSelection(state, dispatch, 0);
                setThumbMenu(null);
              }}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}
            >
              <span>Clear</span>
              <MenuKey binding={bindingFor("rate.0", state.prefs.hotkeys)} />
            </button>
          </SubMenu>
          {([
            ["Pick", "pick", "thumb-menu-pick", "flag.pick"],
            ["Reject", "reject", "thumb-menu-reject", "flag.reject"],
            ["Clear Flag", "", "thumb-menu-unflag", "flag.none"],
          ] as const).map(([label, flag, testid, cmd]) => (
            <button
              key={testid}
              data-testid={testid}
              onClick={() => {
                flagSelection(state, dispatch, flag);
                setThumbMenu(null);
              }}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 18 }}
            >
              <span>{label}</span>
              <MenuKey binding={bindingFor(cmd, state.prefs.hotkeys)} />
            </button>
          ))}
          {/* Keywords beside the rating and flags: they are all tagging, and the
thumbnail is where the photo is. "I should be able to add
tags from the right click menu", and "click an X next to a tag to
remove it from a photo."*/}
          <SubMenu label="Tags" testid="thumb-menu-tag">
            <TagMenu
              ids={
                state.imageSelection.includes(thumbMenu.id)
                  ? state.imageSelection
                  : [thumbMenu.id]
              }
              dispatch={dispatch}
            />
          </SubMenu>
          {/* The same merges as the Photo menu, where the frames are.
              Right-clicking a selection is how anyone reaches for this
              first. */}
          {state.imageSelection.length > 1 && (
            <>
              <div className="sep" />
              <div style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--text-ghost)", padding: "3px 9px" }}>
                {state.imageSelection.length} FRAMES SELECTED
              </div>
              {/* One submenu for everything that turns several frames
                  into one photograph, mirroring the Photo menu. Flat,
                  these five crowded out the everyday actions. */}
              <SubMenu label="Stacking" testid="thumb-menu-stacking">
                {STACK_KINDS.map((k) => (
                  <button
                    key={k.mode}
                    data-testid={`thumb-menu-${k.mode}`}
                    data-hint={k.hint}
                    onClick={() => {
                      void mergeSelection(state, dispatch, k.mode);
                      setThumbMenu(null);
                    }}
                  >
                    {k.label}
                  </button>
                ))}
                <div className="sep" />
                <button
                  data-testid="thumb-menu-panorama"
                  data-hint="Stitch overlapping frames into one wide photograph"
                  onClick={() => {
                    void stitchSelection(state, dispatch);
                    setThumbMenu(null);
                  }}
                >
                  Stitch to Panorama…
                </button>
              </SubMenu>
            </>
          )}
          {/* Joining an EXISTING stack, one frame or many ("there is
a context menu for 'Add to stack...' and it lists the stack node(s)
in the same directory"). Offered whenever the folder holds a stack
the selection is not part of; the backend vets each frame and names
its rejects.*/}
          {(() => {
            const { stacks, frames } = stackAppendTargets(state);
            if (!stacks.length) return null;
            return (
              <SubMenu label="Add to Stack" testid="thumb-menu-add-to-stack">
                {stacks.map((s) => (
                  <button
                    key={s.id}
                    data-testid={`thumb-menu-add-to-${s.id}`}
                    data-hint={`Append the selected frame${frames.length === 1 ? "" : "s"} to this stack's merge`}
                    onClick={() => {
                      void stackAppend(s.id, frames)
                        .then((info) => {
                          // The active photo cannot be the stack (it
                          // is in the selection, and selected stacks
                          // are not offered), so no re-render is owed
                          // here; the backend logs what joined.
                          if (!info) logMsg("warn", "Add to stack did nothing: not in the app?");
                        })
                        .catch((e) => logMsg("error", `Add to stack failed: ${String(e)}`));
                      setThumbMenu(null);
                    }}
                  >
                    {s.name}
                  </button>
                ))}
              </SubMenu>
            );
          })()}
          {/* Hiding is any photograph's, and with the Edit menu item gone (The
report: 'Remove "Hide from Catalog..." from the Edit menu'), this
right-click is the menu path to it. Bake and Delete still live on
merges only: "The context menu for merged should have an option to
delete. Not for photos." A merge is a recipe you made and can remake;
a negative is not.*/}
          <div className="sep" />
          {bakeable(state).length > 0 && (
            /* "an option for stacks to bake an image. To take the
recipe and bake it down to an image on disk." The only entry that
was below it wrote to disk destructively and is gone, so this now
closes the menu.*/
            <button
              data-testid="thumb-menu-bake"
              data-hint="Freeze the edits in a new file beside the original, leaving the original untouched"
              onClick={() => {
                dispatch({ type: "open_bake", ids: taggingTargets(state) });
                setThumbMenu(null);
              }}
            >
              Bake to Image…
            </button>
          )}
          {/* Below hiding, because it is the bigger of the two and the
              order should let somebody stop at the smaller one. Not
              styled as a danger: it renames a file into a folder beside
              itself, and coloring that red would put it in the same
              class as the thing this app no longer does. */}
          {/* Only for a photograph that has actually moved. An always-on
              Relink invites people to re-point files that are exactly
              where they should be. */}
          {taggingTargets(state).some((id) => state.images.find((i) => i.id === id)?.missing) && (
            <button
              data-testid="thumb-menu-relink"
              data-hint="Point this photograph at the file it moved to, and find the rest of the move with it"
              onClick={() => {
                void relinkFrom(state, dispatch);
                setThumbMenu(null);
              }}
            >
              Relink…
            </button>
          )}
          <button
            data-testid="thumb-menu-trash"
            data-hint="Move the files into a .trash folder beside them; nothing is deleted"
            onClick={() => {
              askTrash(state, dispatch);
              setThumbMenu(null);
            }}
          >
            Move to Trash…
          </button>
        </MenuSurface>
    </FixedMenu>
  );
}

/** The corner mark on a photograph whose file has moved.
 *
 * Bottom-left, away from the edited badge, so a photograph that is both
 * edited and missing says both things rather than one covering the
 * other. That pairing is the whole case the owner described: "if a
 * photo had been edited and then later moved."
 */
/** The link mark: this photograph takes the edits made on the others in
 * its group. Top-left, the corner the edited and missing marks leave
 * free. The active photograph's own group lights in accent so its
 * members can be told from every other link in the folder
 * ("if I was to link a different group of photos in the same folder
 * they would all have the same icon"); other groups stay quiet, and a
 * member pinned out for the session is quieter still.*/
function LinkMark({ id, pinned, mine }: { id: string; pinned: boolean; mine: boolean }) {
  return (
    <div
      data-testid={`thumb-link-${id}`}
      data-pinned={pinned || undefined}
      data-mine={mine || undefined}
      title={pinned ? "Linked, pinned out: edits pass this photograph by" : mine ? "Linked with the open photograph: edits here land on each other" : "Linked with others: open one of them to see which"}
      style={{
        position: "absolute", left: 3, top: 3, display: "inline-flex",
        background: "rgba(0,0,0,.7)", padding: 2,
        color: pinned ? "var(--text-ghost)" : mine ? "var(--accent)" : "var(--text-dim)",
        opacity: mine || pinned ? 1 : 0.7,
      }}
    >
      <LinkIcon size={10} />
    </div>
  );
}

function MissingMark({ id }: { id: string }) {
  return (
    <div
      data-testid={`thumb-missing-${id}`}
      title="The file has moved or been renamed. Right-click to relink it."
      style={{
        position: "absolute", left: 3, bottom: 3, display: "inline-flex",
        background: "rgba(0,0,0,.7)", padding: 2, color: "var(--reject)",
      }}
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M2.5 4.5h4l1.2 1.5h5.8v7h-11z" strokeLinejoin="round" />
        <path d="M6 8.5l4 3M10 8.5l-4 3" />
      </svg>
    </div>
  );
}

function RibbonImpl({ state, dispatch }: { state: State; dispatch: D }) {
  const [thumbMenu, setThumbMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  if (!state.ribbonOpen) {
    // Collapsed tick-bar study (frame 4c): one tick per image.
    return (
      <div className="panel-col" style={{ width: 26, alignItems: "center", paddingTop: 8, gap: 4 }} data-testid="ribbon-collapsed">
        {state.images.map((img) => {
          const active = img.id === state.activeImage;
          return (
            <button
              key={img.id}
              aria-label={`Image ${img.name}`}
              onClick={() => dispatch({ type: "select_image", id: img.id })}
              style={{
                all: "unset", cursor: "pointer", width: 12,
                height: active ? 18 : img.edited ? 10 : 6,
                background: active ? "var(--accent)" : img.edited ? "#575c62" : "var(--line-4)",
              }}
            />
          );
        })}
        <button
          style={{ all: "unset", cursor: "pointer", marginTop: "auto", padding: 6 }}
          aria-label="Expand ribbon"
          onClick={() => dispatch({ type: "toggle_ribbon" })}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" style={{ transform: "rotate(180deg)" }}>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>
    );
  }
  const shown = visibleImages(state);
  // The shot-date filter's other half: reads the dates a set range
  // needs from the catalog, and only then; here rather than the viewer
  // because the filter is the ribbon's, filmstrip or catalog browser.
  const dateRunner = <ShotDateRunner state={state} dispatch={dispatch} />;
  // Expanded, the panel is the window: the viewport is gone and this is
  // the catalog surface, a grid or metadata table of the whole folder,
  // with Compare behind it. "I want the views to manage the
  // catalogs of pictures to be separate from the actual editing of
  // individual files."
  if (state.ribbonExpanded) {
    // The catalog grid and table replace the filmstrip wholesale, and for a
    // while they silently ate right-clicks. "the right click
    // menu for thumbnails does not work when expanding the thumbnail view
    // to full size browser view." Same menu, same selection rules.
    return (
      <>
        {thumbMenu && (
          <ThumbMenu state={state} dispatch={dispatch} thumbMenu={thumbMenu} setThumbMenu={setThumbMenu} />
        )}
        <CatalogView state={state} dispatch={dispatch} onThumbContext={setThumbMenu} />
        {dateRunner}
      </>
    );
  }
  const cell = thumbCell(state.panelSizes.ribbon, state.prefs.ribbonMaxWidth);
  return (
    <div
      className="panel-col ui-zoom"
      style={{ width: state.panelSizes.ribbon }}
      data-testid="ribbon"
    >
      {thumbMenu && (
        <ThumbMenu state={state} dispatch={dispatch} thumbMenu={thumbMenu} setThumbMenu={setThumbMenu} />
      )}
      <div style={{ flex: "none", borderBottom: "1px solid var(--line-1)", padding: "8px 9px 7px" }}>
        {/* The owner's layout, revised 2026-09-02: "XX/XX [Photo view]" then
"[Thumb][List] [Filter]". The count sits on the left over the view
switches, the way into the catalog takes the right corner over the
filter, so each row's ends line up.*/}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
          {/* The count wraps under shown/total when the ribbon is too
              narrow for both beside the expand button. */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2, minWidth: 0, flex: "1 1 auto" }}>
            <div className="tnum" style={{ fontSize: 11, color: "var(--text-ghost)" }} data-testid="filter-count">
              {shown.length}/{state.images.length}
            </div>
            {/* How many are selected, readable at a glance
                (2026-10-08: "it's hard to tell how many images are
                selected in the ribbon"): only for a selection of two or
                more, the case a merge, a batch export or a sync acts on.
                The accent color sets it apart; both it and the count are
                11px ("the same font size as the XX/YY label", then
                "make both 11px"). */}
            {state.imageSelection.length > 1 && (
              <div className="tnum" style={{ fontSize: 11, color: "var(--accent)", whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }} data-testid="ribbon-selected">
                {state.imageSelection.length} selected
              </div>
            )}
          </div>
          <RibbonExpandButton dispatch={dispatch} />
        </div>
        {/* Thumb and List back on the left, the filter right-weighted with
clear water between them ("Move the Filter button to be
right weighted so the Thumb & List buttons move back to the left").*/}
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 6 }}>
          <RibbonControls state={state} dispatch={dispatch} />
          <div style={{ marginLeft: "auto" }}>
            {/* The menu hangs toward wherever the room is: leftward over the
library when it is open, rightward over the viewer when it is
collapsed and the panel sits at the window's edge
("Filter menu needs to expand to the right when Library is
collapsed, otherwise it gets cut off").*/}
            <FilterMenu state={state} dispatch={dispatch} align={state.browserOpen ? "right" : "left"} />
          </div>
        </div>
      </div>
      <ThumbnailStrip count={shown.length} rowHeight={state.ribbonView === "list" ? 29 : cell.h + 18} activeIndex={shown.findIndex(i => i.id === state.activeImage)}>
        {(index) => {
          const img = shown[index];
          const active = img.id === state.activeImage;
          // In the selection but not the one on screen: shown more
          // quietly, so a span picked for stacking reads as a group
          // without competing with the photo you are looking at.
          const picked = state.imageSelection.includes(img.id) && !active;
          return (
            <div
              role="group"
              aria-label={img.name}
              key={img.id}
              data-testid={`thumb-${img.id}`}
              data-selected={active || picked}
              onClick={(e) =>
                dispatch({
                  type: "select_image_range",
                  id: img.id,
                  additive: e.ctrlKey || e.metaKey,
                  range: e.shiftKey,
                })
              }
              onKeyDown={e => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); const r=e.currentTarget.getBoundingClientRect(); e.currentTarget.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:r.left,clientY:r.bottom})); } }}
              onContextMenu={(e) => {
                e.preventDefault();
                // A Mac's Control-click lands here instead of on the click above; it is
                // the ctrl of "ctrl adds or removes", so it picks rather than opening
                // the menu.
                if (isMacControlClick(e)) {
                  dispatch({ type: "select_image_range", id: img.id, additive: true });
                  return;
                }
                // Right-clicking outside the selection moves to that
                // photo first, so the menu always acts on what is
                // highlighted.
                if (!state.imageSelection.includes(img.id)) {
                  dispatch({ type: "select_image_range", id: img.id });
                }
                setThumbMenu({ x: e.clientX, y: e.clientY, id: img.id });
              }}
              style={{ all: "unset", cursor: "pointer", display: "block", width: "100%" }}
            >
              {/* List view is the same photographs with the picture turned down to a
stripe: the name and its marks get the width instead. "We
also need to be able to switch between thumbnail and list view."*/}
              {state.ribbonView === "list" ? (
                <div
                  data-testid={`row-${img.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 4px",
                    background: active ? "var(--bg-row)" : "transparent",
                    borderLeft: `2px solid ${active ? "var(--accent)" : picked ? "var(--pick)" : "transparent"}`,
                  }}
                >
                  <button type="button" className="thumb-action" aria-label={`Select ${img.name}`} style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                    <div style={{ width: 26, height: 20, flex: "none", background: "#111010" }}>
                      <ThumbBox
                        id={img.id}
                        src={img.src}
                        // Too small for the mark; the shimmer alone says
                        // "on its way".
                        pending={<div className="thumb-pending" />}
                      >
                        <img
                          src={img.src}
                          alt={img.name}
                          style={{ width: "100%", height: "100%", objectFit: "cover", filter: img.filter }}
                        />
                      </ThumbBox>
                    </div>
                    <span
                      className="tnum"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontSize: 10,
                        color: active ? "var(--text-strong)" : "var(--text-faint)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {img.name}
                    </span>
                  </button>
                  <StarRow img={img} active={active} state={state} dispatch={dispatch} />
                  <FlagToggle img={img} state={state} dispatch={dispatch} />
                </div>
              ) : (
                <>
                  <button type="button" className="thumb-action" aria-label={`Select ${img.name}`}
                    data-edited={img.edited}
                    style={{
                      // Scaled with the panel. The bitmap behind it is
                      // rendered once at 2x the old size, so dragging the
                      // divider re-renders nothing at all.
                      display: "block", width: "100%", position: "relative", height: cell.h, background: "#111010",
                      border: `1px solid ${active ? "var(--accent)" : picked ? "var(--pick)" : img.edited ? "var(--accent-dim)" : "var(--line-3)"}`,
                      outline: active ? "1px solid var(--accent)" : "none", outlineOffset: -1,
                    }}
                  >
                    <ThumbBox
                      id={img.id}
                      src={img.src}
                      pending={<div aria-label={`${img.name} loading`} style={{ width: "100%", height: "100%", background: "#161514" }} />}
                    >
                      {/* contain, not cover: portrait shots letterbox upright in
                          the fixed-height cell instead of being cropped sideways. */}
                      <img src={img.src} alt={img.name} style={{ width: "100%", height: "100%", objectFit: "contain", filter: img.filter }} />
                    </ThumbBox>
                    {img.edited && (
                      <div style={{ position: "absolute", right: 3, top: 3, background: "rgba(0,0,0,.65)", padding: 2 }}>
                        <GroupGlyph size={9} />
                      </div>
                    )}
                    {/* The file has moved and the thumbnail is the cached one.
"it still loads the thumbnail but indicates that the source file is
missing." A corner mark rather than a gray box, because the picture is
the thing that lets somebody recognize which photograph needs finding.*/}
                    {img.missing && <MissingMark id={img.id} />}
                    {img.linkGroup && (
                      <LinkMark
                        id={img.id}
                        pinned={state.linkPinned.includes(img.id)}
                        mine={img.linkGroup === state.images.find((i) => i.id === state.activeImage)?.linkGroup}
                      />
                    )}
                  </button>
                  <div style={{ height: 15, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 2px" }}>
                    <StarRow img={img} active={active} state={state} dispatch={dispatch} />
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <FlagToggle img={img} state={state} dispatch={dispatch} />
                      <span className="tnum" style={{ fontSize: 9, color: "var(--text-ghost)" }}>{img.name}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        }}
      </ThumbnailStrip>
      {state.thumbProgress && (
        <div style={{ flex: "none" }}>
          {/* The count in words, not only a sliver of gold: background
              work the user can read stops feeling like an app that has
              stopped responding. */}
          <div
            className="tnum"
            style={{
              padding: "2px 8px",
              fontSize: 9,
              color: "var(--text-ghost)",
              letterSpacing: ".04em",
            }}
          >
            Developing thumbnails {state.thumbProgress.done}/{state.thumbProgress.total}
          </div>
          <div
            data-testid="thumb-progress"
            data-hint={`Generating thumbnails: ${state.thumbProgress.done}/${state.thumbProgress.total}`}
            style={{ height: 3, background: "var(--line-2)" }}
          >
            <div
              style={{
                height: "100%",
                width: `${(state.thumbProgress.done / Math.max(1, state.thumbProgress.total)) * 100}%`,
                background: "var(--accent)",
                transition: "width .2s",
              }}
            />
          </div>
        </div>
      )}
      {/* Which way the strip runs. "The thumbnail view needs two
buttons above collapse to sort ascending and descending." Two
buttons rather than one that flips, so the current direction is
readable without pressing anything: the lit one IS the answer.

          By file name, which is the order the catalog hands them over
          in and, on any camera, the order they were taken. The pair
          sets the DIRECTION only and leaves the list view's chosen
          column alone, so a trip through the thumbnails does not
          quietly re-sort the table. */}
      <div
        style={{
          flex: "none", display: "flex", alignItems: "center",
          gap: 4, padding: "4px 6px", borderTop: "1px solid var(--line-1)",
        }}
      >
        {([
          [false, "A-Z", "M12 19V5M5 12l7-7 7 7", "Oldest first: the strip runs in file-name order, which on any camera is the order they were taken."],
          [true, "Z-A", "M12 5v14M5 12l7 7 7-7", "Newest first: the same list read from the other end, so the last frame of the shoot is at the top."],
        ] as [boolean, string, string, string][]).map(([desc, label, path, hint]) => (
          <button
            key={label}
            className="chip small"
            data-testid={`ribbon-sort-${desc ? "desc" : "asc"}`}
            data-active={state.ribbonSort.desc === desc}
            aria-pressed={state.ribbonSort.desc === desc}
            aria-label={desc ? "Sort thumbnails descending" : "Sort thumbnails ascending"}
            data-hint={hint}
            // Half the strip each. "The ascending/descending sorting
            // buttons should stretch to fill the width." Two equal halves also
            // make the lit one unmissable, which is the whole reason there are two
            // of them rather than one that flips. nowrap because the strip narrows
            // a long way and a label folding onto a second line would take the
            // row's height with it.
            style={{
              flex: 1, display: "inline-flex", alignItems: "center",
              justifyContent: "center", gap: 3, whiteSpace: "nowrap",
            }}
            onClick={() => dispatch({ type: "set_ribbon_sort", desc })}
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden focusable="false">
              <path d={path} />
            </svg>
            {label}
          </button>
        ))}
      </div>
      {/* Glyph and label take their color from the button so the hover
          lift reaches both, which an inline stroke and an inline color
          were each quietly blocking. */}
      <button
        className="foldbar"
        data-testid="ribbon-collapse"
        data-hint="Fold the thumbnail strip away and give the room to the photograph."
        data-hint-cmd="view.ribbon"
        aria-label="Collapse ribbon"
        onClick={() => dispatch({ type: "toggle_ribbon" })}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span style={{ fontSize: 9, letterSpacing: ".14em" }}>COLLAPSE</span>
      </button>
      {dateRunner}
    </div>
  );
}

// The chrome panes are memoized against everything but the view-only
// fields (see viewmemo.ts): panning and zooming dispatch through the
// top-level reducer at wheel rate, and none of it changes what these
// panels draw. Without the boundary, every notch re-rendered the whole
// window.
export const TopBar = memo(TopBarImpl, panePropsEqual);
export const TabRail = memo(TabRailImpl, panePropsEqual);
export const BrowserPanel = memo(BrowserPanelImpl, panePropsEqual);
export const Ribbon = memo(RibbonImpl, panePropsEqual);
