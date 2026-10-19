// catalogui.tsx's values and helpers that are not components, kept apart so
// catalogui.tsx exports components alone and Vite can refresh it in place as
// it is edited instead of reloading the window.
import type { Command, Confirm } from "../state";
import { type RecoveryReport, flushFolder, hideFolder, openCatalog, parseUpgradePending, type CatalogInfo } from "../bridge";
import { currentNavigation, refreshLibrary, restoreCatalogSession } from "./chromeparts";
import { folderLeft, isWithin, reloadCollection } from "./collectionnav";
import { askCatalogUpgrade } from "../catalogupgrade";
import { logMsg } from "../log";
import { flushRecoverySaves } from "../savebarrier";

export type D = React.Dispatch<Command>;

/** Bytes as something a person can judge. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function names(list: string[]): string {
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list[0]} and ${list.length - 1} others`;
}

/** What each prompt says.
 *
 * Exported because the copy is the safety feature. A dialog that says
 * "are you sure?" twice teaches people to click twice; the second prompt
 * here has to say something the first one did not.
 */
export function confirmCopy(confirm: Confirm): {
  title: string;
  body: string;
  ok: string;
  danger: boolean;
  /** The second button's word when "Cancel" would be wrong: a notice
   * is not canceled, it is put off. */
  cancel?: string;
} {
  const a = confirm.action;

  if (a.kind === "backup_failed") {
    return {
      title: "Catalog backup failed",
      body: a.message,
      ok: "Open Preferences",
      danger: true,
      cancel: "Later",
    };
  }

  if (a.kind === "trash_images" && a.missing?.length === a.ids.length) {
    // Nothing here has a file to move: the question is a different one.
    const what = a.ids.length === 1 ? names(a.names) : `These ${a.ids.length} photographs`;
    const its = a.ids.length === 1 ? "Its" : "Their";
    return {
      title: "Remove from catalog",
      body: `${what} ${a.ids.length === 1 ? "is" : "are"} not where the catalog says, so there is nothing to move to the trash. ${its} catalog record${a.ids.length === 1 ? "" : "s"} will be removed instead: ratings, flags, keywords and collections are forgotten, the edits are kept, and nothing on disk is touched. If the file moved, Relink finds it instead.`,
      ok: "Remove from catalog",
      danger: false,
    };
  }
  if (a.kind === "trash_images") {
    const what = a.ids.length === 1 ? names(a.names) : `${a.ids.length} photographs`;
    const gone = a.missing?.length ?? 0;
    const missingNote = gone
      ? ` ${gone} of them ${gone === 1 ? "is" : "are"} not where the catalog says, so there is nothing to move: ${gone === 1 ? "its record is" : "their records are"} removed from the catalog instead.`
      : "";
    return {
      title: "Move to trash",
      // Says where the file goes, in words the user can act on without
      // this app: the folder is plain, visible and beside the images.
      // Nothing here empties it, which is the other half of the promise
      // and the reason this is not called Delete.
      body: `${what} will be moved into a .trash folder beside them. The files are not deleted and nothing is lost: ratings, flags and edits are kept, and Put Back returns them. Heeler never empties the trash, so delete that folder yourself when you are sure.${missingNote}`,
      ok: "Move to trash",
      danger: false,
    };
  }
  if (a.kind === "delete_take") {
    return {
      title: "Delete take",
      // Says what goes and what does not. The photograph is never at risk
      // here, and the thing that IS at risk has no undo behind it.
      body: `"${a.name}" and the edits in it will be deleted. The photograph and your other takes are untouched. This one cannot be undone: history belongs to the take it was made in.`,
      ok: "Delete take",
      danger: true,
    };
  }
  if (a.kind === "hide_folder") {
    const name = a.path.split(/[\\/]/).filter(Boolean).pop() ?? a.path;
    const inside = a.folders > 1 ? ` and the ${a.folders - 1} folder${a.folders === 2 ? "" : "s"} inside it` : "";
    return {
      title: "Hide folder",
      // Says what does NOT happen, because that is the whole point of
      // Hide as against Flush: nothing is deleted or forgotten.
      body: `${name}${inside} will leave the Folders list. Nothing is deleted or forgotten: the ${a.images.toLocaleString()} photograph${a.images === 1 ? "" : "s"} keep their ratings, flags, keywords, collections and edits, and opening the folder again brings it back.`,
      ok: "Hide folder",
      danger: false,
    };
  }
  if (a.kind === "flush_folder") {
    const name = a.path.split(/[\\/]/).filter(Boolean).pop() ?? a.path;
    // This folder alone leaves its subfolders' records as they are.
    const inside = a.only
      ? " (its own photographs only; the folders inside it keep their records)"
      : a.folders > 1 ? ` and the ${a.folders - 1} folder${a.folders === 2 ? "" : "s"} inside it` : "";
    const photos = `${a.images.toLocaleString()} photograph${a.images === 1 ? "" : "s"}`;
    // The trashed ones go from the catalog too, which the count used to
    // leave out. Their files stay in .trash,
    // and opening the folder again reads them back from its index.
    const t = a.trashed ?? 0;
    const trashNote = t
      ? ` The ${t.toLocaleString()} photograph${t === 1 ? "" : "s"} in its .trash ${t === 1 ? "is" : "are"} forgotten too; the file${t === 1 ? " stays" : "s stay"} in .trash, and opening the folder again finds ${t === 1 ? "it" : "them"} there.`
      : "";
    return confirm.step === 1
      ? {
          title: "Flush folder",
          // The first page says what goes and what stays. The second
          // says something the first did not: that there is no undo,
          // and exactly what would have to be redone.
          body: `${name}${inside} will be forgotten by the catalog, with the ratings, flags, keywords and collection membership of ${photos}. The files stay where they are, and their edits are kept outside the catalog and return if the folder is added again. To keep the records and only clear the list, use Hide folder instead.${trashNote}`,
          ok: "Flush folder…",
          danger: true,
        }
      : {
          title: "Flush folder: there is no undo",
          body: `The ratings, flags, keywords and collection membership of ${photos} cannot be brought back once flushed; they would have to be set again by hand. The photographs and their edits are not affected.`,
          ok: `Flush ${photos}`,
          danger: true,
        };
  }
  if (a.kind === "forget_missing_folder") {
    const name = a.path.split(/[\\/]/).filter(Boolean).pop() ?? a.path;
    const n = a.ids.length;
    const photos = `${n.toLocaleString()} photograph${n === 1 ? "" : "s"}`;
    return {
      title: "Forget missing photos",
      body: `${photos} in ${name} ${n === 1 ? "is" : "are"} not where the catalog says. ${n === 1 ? "Its record is" : "Their records are"} removed: ratings, flags, keywords and collections are forgotten, the edits are kept, and nothing on disk is touched. The rest of the folder is left as it is. If ${n === 1 ? "it" : "they"} moved, Relink finds ${n === 1 ? "it" : "them"} instead.`,
      ok: `Forget ${photos}`,
      danger: true,
    };
  }
  if (a.kind === "forget_missing_trashed") {
    const n = a.ids.length;
    const photos = `${n.toLocaleString()} trashed photograph${n === 1 ? "" : "s"}`;
    const skipped = a.skipped
      ? ` ${a.skipped.toLocaleString()} on a drive that is not connected (${a.skippedVolumes.join(", ")}) ${a.skipped === 1 ? "is" : "are"} not checked and stay${a.skipped === 1 ? "s" : ""}.`
      : "";
    return {
      title: "Forget missing trashed photos",
      // Outcome first: what leaves, what is never touched, and where
      // the edits still live. The list of paths follows in the dialog.
      body: `Removes ${photos} and ${n === 1 ? "its" : "their"} edits from the catalog. ${n === 1 ? "Its file is" : "Their files are"} no longer in .trash, removed outside Heeler. No file on disk is touched, and recovery bundles made earlier still hold ${n === 1 ? "its" : "their"} edits. There is no undo.${skipped}`,
      ok: `Forget ${n.toLocaleString()} photograph${n === 1 ? "" : "s"}`,
      danger: true,
    };
  }
  if (a.kind === "delete_collection") {
    const stay =
      a.count === 0
        ? "It holds no photographs."
        : a.count === 1
          ? "The photograph in it stays in the catalog and on disk, with its rating, flag and edits."
          : `The ${a.count.toLocaleString()} photographs in it stay in the catalog and on disk, with their ratings, flags and edits.`;
    return {
      title: "Delete collection",
      // Says what does NOT go, since "delete" next to a list of
      // photographs reads as deleting them, and that the list itself
      // comes back with Undo.
      body: `"${a.name}" will be deleted. ${stay} Undo brings the collection back.`,
      ok: "Delete collection",
      danger: false,
    };
  }
  if (a.kind === "recover_hidden") {
    return {
      title: "Recover hidden",
      body:
        a.count === 1
          ? "1 hidden photograph will reappear in this folder, with the rating and edits it had."
          : `${a.count} hidden photographs will reappear in this folder, with the ratings and edits they had.`,
      ok: "Recover",
      danger: false,
    };
  }
  // Every kind is answered above. There is no trailing branch because
  // there is no action left that this file does not have words for:
  // delete from disk was the one that needed a second, graver page, and
  // it is gone. TypeScript narrows `a` to never here, which is the
  // clearest possible statement that the list is complete.
  throw new Error(`no confirmation copy for ${JSON.stringify(a)}`);
}

/** What to say when some of them stayed put.
 *
 * Names the first reason rather than counting silently: "3 could not be
 * moved" tells the user something went wrong and nothing about what,
 * and the reason is usually the same one for all three.
 */
export function trashFailure(failed: string[]): string {
  const first = failed[0];
  return failed.length === 1
    ? `Could not move to trash. ${first}`
    : `Could not move ${failed.length} to trash. ${first}`;
}

/** Hides or flushes a folder, then puts the library back on its feet:
 * the list is rebuilt, and if the folder on screen was the one that
 * left, the session is restored from whatever the catalog now holds
 * rather than left showing a folder the list no longer has. */
export async function leaveFolder(command: "hide" | "flush", path: string, dispatch: D, only = false): Promise<void> {
  const viewing = currentActiveFolder;
  const collection = currentCollection;
  const affected = viewing !== null && (only ? isWithin(viewing, path) && isWithin(path, viewing) : isWithin(viewing, path));
  // Noted before the wait: a folder clicked while the command runs is
  // newer than the collection reload below, which must give way to it.
  const nav = currentNavigation();
  if (affected) {
    await flushRecoverySaves();
    dispatch({ type: "begin_session_load" });
  }
  try {
    if (command === "hide") {
      await hideFolder(path);
      logMsg("info", `Hid ${path} from the library. Nothing was deleted; open the folder again to bring it back.`);
    } else {
      const r = await flushFolder(path, only);
      logMsg("info", `Flushed ${path}: the catalog forgot ${r.images.toLocaleString()} photograph${r.images === 1 ? "" : "s"} in ${r.folders} folder${r.folders === 1 ? "" : "s"}. No file was touched.`);
    }
  } finally {
    // Whatever still remembers this folder as the way back out of a
    // collection lets go of it: stepping off the collection would open
    // it again, and opening it adds it back.
    folderLeft(path, only);
    if (affected) {
      try { await restoreCatalogSession(dispatch); }
      catch (e) { logMsg("error", `Could not restore the catalog session: ${String(e)}`); }
    } else if (collection) {
      // A collection on screen may hold photographs from the folder that
      // left. A flush forgot them and a hide hid them, so the ribbon
      // must not go on showing them.
      try { await reloadCollection(collection.id, collection.label, dispatch, collection.thumbnailEdge, nav); }
      catch (e) { logMsg("error", `Could not show the collection again: ${String(e)}`); }
    }
    await refreshLibrary(dispatch);
  }
}

/** The folder the library is showing, told to this module by the
 * dialog that has the state; folder commands read it to know whether
 * they are pulling the rug out from under the view. With a collection
 * open there is no folder on screen, and the collection is noted
 * instead, so a folder command can show it again. */
export let currentActiveFolder: string | null = null;

export let currentCollection: { id: number; label: string; thumbnailEdge: number } | null = null;

export function noteActiveFolder(
  path: string | null,
  collection: { id: number; label: string; thumbnailEdge: number } | null = null,
): void {
  currentActiveFolder = path;
  currentCollection = collection;
}

/** A bundle's result as plain lines: the verdict and counts first,
 * then every problem on its own line, the notes, and the full list of
 * missing originals (the problem line names only the first few).
 * Lines rather than one run-on sentence (2026-10-01: the result
 * showed a single line he could neither read in full nor copy).*/
export function recoveryNote(r: RecoveryReport): string {
  const head = `${r.complete ? "Complete" : "Incomplete"}: ${r.images} photographs, ${r.graphs} graphs, ${r.takes} takes, ${r.presets} presets, ${r.assets} referenced assets, ${r.required_inputs} baked inputs. Heeler ${r.app_version}. ${r.path}${r.problems.length ? "" : ". Original files match their checksums."}`;
  const lines = [head];
  if (r.problems.length) lines.push("", r.problems.length === 1 ? "Problem:" : `${r.problems.length} problems:`, ...r.problems.map(p => `- ${p}`));
  if (r.notes?.length) lines.push("", ...r.notes.map(n => `${n}.`));
  const missing = r.missing_originals ?? [];
  if (missing.length) lines.push("", `Missing originals (${missing.length.toLocaleString()}):`, ...missing);
  return lines.join("\n");
}

/** open_catalog with the schema update gate answered (26.3): an older
 * catalog is refused with the typed upgrade-pending error, so run the
 * update prompt and retry the open once. Approval marks the path for
 * the session (and opens it at once when it is the active catalog), so
 * the retry passes the gate. Quit answers null: the app is closing. */
export async function openCatalogHandlingUpgrade(path: string): Promise<CatalogInfo | null> {
  try {
    return await openCatalog(path);
  } catch (e) {
    const pending = parseUpgradePending(e);
    if (!pending) throw e;
    if (!(await askCatalogUpgrade(pending))) return null;
    return await openCatalog(path);
  }
}

/** Switches to another catalog from outside the dialog (the File menu's
 * recent list), with the dialog's own discipline: the on-screen session
 * is dropped BEFORE the switch, because the debounced session saver
 * keys off that state and letting it live through the switch is how
 * the old catalog's folders got written into the new catalog's memory;
 * afterwards the session and the library are rebuilt from whichever
 * catalog is open. Returns the sentence for the status line. */
export async function switchCatalog(path: string, dispatch: D, thumbnailEdge = 480): Promise<string> {
  await flushRecoverySaves();
  dispatch({ type: "begin_session_load" });
  const problems: string[] = [];
  let result = "";
  try {
    const c = await openCatalogHandlingUpgrade(path);
    result = c ? `Opened ${c.path}: ${c.images.toLocaleString()} photographs.` : "";
  } catch (e) {
    problems.push(String(e));
  } finally {
    try { await restoreCatalogSession(dispatch, undefined, thumbnailEdge); }
    catch (e) { problems.push(`Could not restore the catalog session: ${String(e)}`); }
    try { await refreshLibrary(dispatch); }
    catch (e) { problems.push(`Could not refresh the library: ${String(e)}`); }
  }
  return [result, ...problems].filter(Boolean).join(" ");
}
