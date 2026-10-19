// The folder tree's listings: every place that asks the disk for a
// folder's subfolders and puts them on its node in the tree.
//
// Each of them used to list and set the node for itself, with its own
// answer to a listing that fails or is overtaken by a newer click, and
// one that took a failure for an empty folder collapsed an ejected
// card's branch, expanded state and all. listIntoTree says what a listing
// came to, the tree keeping what it had unless there is an answer, and
// each caller decides from that alone what it does next.

import { createFolder, listSubfolders, type SubfolderEntry } from "../bridge";
import { logMsg } from "../log";
import type { Command, State, TreeNode } from "../state";
import { ancestorsBetween } from "../state";
import { rememberedExpanded } from "../uiprefs";
import { leafName, navStale, openFolderPlain, refreshLibrary } from "./chromeparts";
import { isWithin } from "./collectionnav";
import { flashStatus } from "./hints";

type D = (command: Command) => void;

/** What listing a folder into the tree came to. */
export type TreeListing =
  | { kind: "listed"; children: SubfolderEntry[] }
  | { kind: "failed"; error: unknown }
  | { kind: "overtaken" };

/** Lists `path`'s subfolders onto its node in the tree, opening the node
 * with `open`. A listing that fails, or that `overtaken` says newer work
 * has replaced, leaves the tree as it was: a failure is never an empty
 * folder. */
export async function listIntoTree(
  path: string,
  dispatch: D,
  how: { open?: boolean; overtaken?: () => boolean } = {},
): Promise<TreeListing> {
  const overtaken = how.overtaken ?? (() => false);
  let children: SubfolderEntry[];
  try {
    children = await listSubfolders(path);
  } catch (error) {
    return overtaken() ? { kind: "overtaken" } : { kind: "failed", error };
  }
  if (overtaken()) return { kind: "overtaken" };
  dispatch({ type: "set_tree_node", path, children, ...(how.open ? { expanded: true } : {}) });
  return { kind: "listed", children };
}

export function treeContains(node: TreeNode | null, path: string): boolean {
  if (!node) return false;
  if (node.path === path) return true;
  return (node.children ?? []).some((c) => treeContains(c, path));
}

/** Lists the branch from the tree's root down to `path` where the tree
 * has not loaded it yet, so a folder picked from inside the tree lands
 * in it rather than replacing the root. Gives way to newer navigation. */
export async function revealInTree(tree: TreeNode | null, path: string, dispatch: D, nav: number): Promise<void> {
  if (!tree || treeContains(tree, path) || !isWithin(path, tree.path)) return;
  for (const ancestor of ancestorsBetween(tree.path, path)) {
    const listed = await listIntoTree(ancestor, dispatch, { open: true, overtaken: () => navStale(nav) });
    if (listed.kind !== "listed") return;
  }
}

/** Opens again the folders that were open under `root` when the tree was
 * last left, shallowest first, so each one's parent is listed before it.
 * One listing each, at most TREE_PATHS; a folder no longer there is
 * skipped. Gives way to newer navigation. */
export async function restoreExpanded(root: string, dispatch: D, nav: number): Promise<void> {
  const depth = (p: string) => p.split(/[\\/]/).length;
  const paths = rememberedExpanded(root)
    .filter((p) => p !== root && isWithin(p, root))
    .sort((a, b) => depth(a) - depth(b));
  for (const path of paths) {
    const listed = await listIntoTree(path, dispatch, { open: true, overtaken: () => navStale(nav) });
    if (listed.kind === "overtaken") return;
  }
}

/** The folders open in a tree, root left out. */
export function expandedPaths(node: TreeNode | null): string[] {
  if (!node) return [];
  const out: string[] = [];
  const walk = (n: TreeNode, top: boolean) => {
    if (!n.expanded) return;
    if (!top) out.push(n.path);
    for (const c of n.children ?? []) walk(c, false);
  };
  walk(node, true);
  return out;
}

/** When a folder above the old tree's root becomes the new root, the old
 * tree goes back in under it as it was, expanded branches and all,
 * instead of being rebuilt collapsed. */
export async function regraftOldTree(old: TreeNode | null, newRoot: string, dispatch: D, nav: number): Promise<void> {
  if (!old || old.path === newRoot || !isWithin(old.path, newRoot)) return;
  for (const ancestor of ancestorsBetween(newRoot, old.path)) {
    const listed = await listIntoTree(ancestor, dispatch, { open: true, overtaken: () => navStale(nav) });
    if (listed.kind !== "listed") return;
  }
  if (!navStale(nav)) dispatch({ type: "graft_tree_node", node: old });
}

/** A folder that would not open says so where the user is looking, and
 * its parent is listed again so a folder that is gone leaves the tree.
 * The failure only reached the log as an unhandled rejection, and the
 * dead row stayed. */
export function folderWouldNotOpen(path: string, e: unknown, dispatch: D): void {
  const why = String(e).replace(/^Error: /, "");
  logMsg("warn", `Could not open ${path}: ${why}`);
  flashStatus(`Could not open ${leafName(path)}: ${why}`);
  const parent = path.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
  if (parent && parent !== path) void listIntoTree(parent, dispatch);
}

/** Makes a folder in `parent` and shows it in the tree, the branch open. */
export async function newFolderIn(parent: string, name: string, dispatch: D): Promise<string | null> {
  try {
    const made = await createFolder(parent, name);
    await listIntoTree(parent, dispatch, { open: true });
    flashStatus(`Made ${leafName(made)}.`);
    return null;
  } catch (e) {
    return String(e).replace(/^Error: /, "");
  }
}

/** Looks at the disk again for one folder. The tree listed a folder
 * once and never again, so folders made, renamed or removed under any
 * folder but the open one never showed. The
 * folder on screen is opened again, which rescans its photographs too. */
export async function refreshFolder(path: string, state: State, dispatch: D): Promise<void> {
  if (state.activeCollection === null && state.activeFolderPath === path) {
    await openFolderPlain(path, state.folderTree, dispatch, state.prefs.thumbnailEdge);
    return;
  }
  const listed = await listIntoTree(path, dispatch);
  if (listed.kind === "failed") folderWouldNotOpen(path, listed.error, dispatch);
  void refreshLibrary(dispatch);
}

/** Bumped to stop an Expand all children still under way: by Collapse
 * all children, and by a new tree root. A slow expand used to open the
 * branches again one by one after the user had collapsed them, or force
 * them open in a tree that had changed under it. */
let expandRun = 0;
export function stopExpanding(): void {
  expandRun += 1;
}

/** How many folders one Expand all children lists at most. */
export const EXPAND_ALL_CAP = 200;

/** Recursively expands the subtree under `path`, breadth-first, capped so
 * a monster archive cannot flood the panel with directory listings. Stops
 * when stopExpanding is called, and says so when it reaches the cap. */
export async function expandAllChildren(path: string, dispatch: D): Promise<void> {
  const run = ++expandRun;
  const queue = [path];
  let visited = 0;
  while (queue.length > 0 && visited < EXPAND_ALL_CAP) {
    const p = queue.shift()!;
    const listed = await listIntoTree(p, dispatch, { open: true, overtaken: () => run !== expandRun });
    if (listed.kind === "overtaken") return;
    visited += 1;
    // One that cannot be listed keeps what the tree had, and the walk
    // goes on with the rest.
    if (listed.kind === "failed") continue;
    queue.push(...listed.children.map((c) => c.path));
  }
  if (queue.length > 0) {
    flashStatus(`Expanded the first ${EXPAND_ALL_CAP} folders. Expand the rest one branch at a time.`);
  }
}
