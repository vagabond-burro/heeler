import { useDialogFocus } from "./dialogfocus";
// Hiding, deleting, and catalog management: the dialogs.
//
// Every destructive action in the app comes through here, which is the
// point. The wording, the number of prompts and what actually happens
// live next to each other rather than being spread over the menus that
// happen to raise them, so "does this delete the user's negatives" is a
// question you can answer by reading one file.

import { useEffect, useRef, useState } from "react";
import type { Confirm, State } from "../state";
import { isFinalPrompt } from "../state";
import { backupCatalog, createRecoveryBundle, verifyRecoveryBundle, pickRecoveryDestination, pickExportFolder, catalogInfo, createCatalog, forgetMissingPhotos, forgetMissingTrashedPhotos, importCatalog, moveCatalog, clearRecentCatalogs, forgetRecentCatalog, recentCatalogs, type RecentCatalog, pickCatalogDestination, pickCatalogFile, restoreCatalog, moveImagesToTrash, recoverHidden, revealCatalog, type CatalogInfo } from "../bridge";
import { refreshLibrary, restoreCatalogSession } from "./chromeparts";
import { forgetCatalogUpgradeApproval } from "../catalogupgrade";
import { logMsg } from "../log";
import { flashStatus } from "./hints";
import { flushRecoverySaves } from "../savebarrier";
import { watchOp } from "./opprogressparts";
import { RIBBON_ICON_CHIP } from "./ribbontableparts";
import { deleteCollectionStep } from "../libraryundo";
import { type D, confirmCopy, humanBytes, leaveFolder, noteActiveFolder, openCatalogHandlingUpgrade, recoveryNote, switchCatalog, trashFailure } from "./cataloguiparts";

/** Runs the action the user has now agreed to. */
async function perform(confirm: Confirm, state: State, dispatch: D): Promise<void> {
  const a = confirm.action;
  if (a.kind === "delete_collection") {
    // Refreshes the library itself, and leaves the collection first if
    // it was the one open.
    await deleteCollectionStep(state, dispatch, a);
    return;
  }
  if (a.kind === "backup_failed") {
    // The way to the fix: the Backup category is one click from the top.
    dispatch({ type: "open_prefs" });
    return;
  }
  if (a.kind === "delete_take") {
    // Purely app state: no file, no catalog row, nothing to refresh.
    dispatch({ type: "delete_take", takeId: a.takeId });
    return;
  }
  if (a.kind === "trash_images") {
    const missing = new Set(a.missing ?? []);
    const present = a.ids.filter((id) => !missing.has(id));
    const report = present.length ? await moveImagesToTrash(present) : { failed: [], moved_ids: [] as string[] };
    // A photograph with no file leaves the catalog rather than failing
    // the rename. The backend asks the disk
    // again, so one whose file came back meanwhile is left alone.
    let forgotten: string[] = [];
    if (missing.size) {
      try {
        forgotten = await forgetMissingPhotos([...missing]);
        if (forgotten.length) {
          logMsg("info", `Removed ${forgotten.length} photograph${forgotten.length === 1 ? "" : "s"} whose file was missing from the catalog. No file was touched.`);
        }
      } catch (e) {
        logMsg("error", `Could not remove the missing photographs from the catalog: ${String(e)}`);
        flashStatus(`Could not remove the missing photographs from the catalog: ${String(e)}`);
      }
    }
    if (report.failed.length) {
      logMsg("error", trashFailure(report.failed));
      // Where the user is looking, too: the dialog closes either way,
      // and a failure only the console heard looked like nothing happened.
      flashStatus(trashFailure(report.failed));
    }
    // Only the ones that actually moved leave the ribbon: the backend
    // names them, so a photograph whose rename failed (read-only,
    // permission) stays in the library it is still sitting in.
    const gone = [...report.moved_ids, ...forgotten];
    if (gone.length) dispatch({ type: "remove_images", ids: gone });
  } else if (a.kind === "forget_missing_folder") {
    try {
      // Asked of the disk again: one whose file came back meanwhile stays.
      const gone = await forgetMissingPhotos(a.ids);
      logMsg("info", `The catalog forgot ${gone.length.toLocaleString()} missing photograph${gone.length === 1 ? "" : "s"} in ${a.path}. No file was touched.`);
      if (gone.length) dispatch({ type: "remove_images", ids: gone });
    } catch (e) {
      logMsg("error", `Could not forget the missing photographs: ${String(e)}`);
      flashStatus(`Could not forget the missing photographs: ${String(e)}`);
    }
  } else if (a.kind === "forget_missing_trashed") {
    try {
      // The backend asks the disk again: one put back, or whose drive
      // went away, since the dialog opened is left alone.
      const n = await forgetMissingTrashedPhotos(a.ids);
      logMsg("info", `The catalog forgot ${n.toLocaleString()} trashed photograph${n === 1 ? "" : "s"} whose file was no longer in .trash. No file was touched.`);
      dispatch({ type: "remove_images", ids: a.ids });
    } catch (e) {
      logMsg("error", `Could not forget the missing trashed photographs: ${String(e)}`);
    }
  } else if (a.kind === "hide_folder" || a.kind === "flush_folder") {
    await leaveFolder(a.kind === "hide_folder" ? "hide" : "flush", a.path, dispatch, a.kind === "flush_folder" && a.only === true);
    return;
  } else {
    await recoverHidden(a.path);
  }
  await refreshLibrary(dispatch);
}

export function ConfirmDialog({ state, dispatch }: { state: State; dispatch: D }) {
  const confirm = state.confirm;
  const confirmFocus = useDialogFocus(!!confirm);
  // The folder commands need to know what the library is showing, and
  // this dialog is the one place that has both the state and the deed.
  noteActiveFolder(
    state.activeFolderPath,
    state.activeCollection === null
      ? null
      : { id: state.activeCollection, label: state.libraryLabel, thumbnailEdge: state.prefs.thumbnailEdge },
  );
  const [busy, setBusy] = useState(false);
  // "Don't show this again", offered on delete_take only. Fresh per
  // prompt: the component stays mounted between dialogs, and a tick
  // left over from the last one would silence this one unasked.
  const [silence, setSilence] = useState(false);
  useEffect(() => setSilence(false), [confirm]);
  if (!confirm) return null;
  const copy = confirmCopy(confirm);
  const last = isFinalPrompt(confirm);

  const yes = () => {
    if (!last) {
      dispatch({ type: "advance_confirm" });
      return;
    }
    // The tick lands only when the deed is confirmed: canceling with
    // it checked silences nothing.
    if (silence && confirm.action.kind === "delete_take") {
      dispatch({ type: "set_prefs", prefs: { confirmDeleteTake: false } });
    }
    setBusy(true);
    void perform(confirm, state, dispatch).finally(() => {
      setBusy(false);
      dispatch({ type: "close_confirm" });
    });
  };

  return (
    <div className="modal-scrim" data-testid="confirm-scrim">
      {/* zoom 1.25, the owner's number ("Increase the font size on the
DELETE TAKE dialog by 1.25x"). This dialog mounts at the App root,
OUTSIDE every ui-zoom wrapper, so it rendered at raw scale while
the chrome around it wore 1.15; one zoom here scales the title,
body and buttons together for every confirmation this surface
carries.*/}
      <div ref={confirmFocus} role="dialog" aria-modal="true" aria-label={copy.title} tabIndex={-1} className="modal" data-testid="confirm-dialog" style={{ width: 420, zoom: 1.25 }}>
        <div
          className="kicker"
          data-testid="confirm-title"
          style={{ color: copy.danger ? "var(--reject)" : undefined }}
        >
          {copy.title}
        </div>
        <p
          data-testid="confirm-body"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-faint)", margin: "10px 0 16px" }}
        >
          {copy.body}
        </p>
        {/* Every path the deed reaches, selectable, in a list that
            scrolls rather than a dialog that grows off the screen. */}
        {confirm.action.kind === "forget_missing_trashed" && (
          <ul
            data-testid="confirm-paths"
            style={{ maxHeight: 160, overflowY: "auto", margin: "0 0 14px", padding: 0, listStyle: "none", fontSize: 11, lineHeight: 1.5, color: "var(--text-faint)", userSelect: "text", wordBreak: "break-all" }}
          >
            {confirm.action.paths.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {confirm.action.kind === "delete_take" && (
          <label
            data-testid="confirm-silence"
            onClick={() => setSilence(!silence)}
            style={{ display: "flex", alignItems: "center", gap: 7, margin: "0 0 12px", cursor: "pointer", fontSize: 10, color: "var(--text-faint)" }}
          >
            <div className="toggle" data-on={silence} role="switch" aria-label="Don't show this again" tabIndex={0} onKeyDown={e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setSilence(!silence); } }} aria-checked={silence}>
              <div className="dot" />
            </div>
            Don't show this again
          </label>
        )}
        {/* Step of step, so a second prompt reads as a second prompt
            rather than as the dialog having failed to close. */}
        {confirm.step > 1 && (
          <div data-testid="confirm-step" style={{ fontSize: 9, color: "var(--text-ghost)", marginBottom: 8 }}>
            SECOND CONFIRMATION
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="chip" data-testid="confirm-cancel" onClick={() => dispatch({ type: "close_confirm" })}>
            {copy.cancel ?? "Cancel"}
          </button>
          <button
            className="chip"
            data-testid="confirm-ok"
            disabled={busy}
            onClick={yes}
            style={copy.danger ? { borderColor: "var(--reject)", color: "var(--reject)" } : undefined}
          >
            {busy ? "Working…" : copy.ok}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One titled group of the dialog. The kicker is the same heading
 * Preferences puts over a category, at the same size, so the two
 * surfaces read as one family. */
function Section({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 18 }}>
      <div className="kicker" style={{ fontSize: 10, letterSpacing: ".14em", paddingBottom: 6 }}>{title}</div>
      {intro && (
        <div style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.55, paddingBottom: 4, maxWidth: 560 }}>{intro}</div>
      )}
      {children}
    </section>
  );
}

/** One thing you can do, on its own row: the button in a fixed column
 * so the seven of them line up, and what it does beside it in words.
 * The hint on the wrapper is the short outcome for the hint bar; the
 * description is the sentence you read before deciding. */
function Action({
  id,
  label,
  hint,
  description,
  disabled,
  onClick,
  initial,
}: {
  id: string;
  label: string;
  hint: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
  initial?: boolean;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "196px minmax(0, 1fr)",
        alignItems: "center",
        gap: 16,
        padding: "9px 0",
        borderTop: "1px solid var(--line-1)",
      }}
    >
      <span data-hint={hint} style={{ display: "block" }}>
        <button
          className="chip"
          data-testid={id}
          data-initial-focus={initial ? "" : undefined}
          disabled={disabled}
          onClick={onClick}
          style={{ display: "block", boxSizing: "border-box", width: "100%", textAlign: "center", fontSize: 11, padding: "3px 9px" }}
        >
          {label}
        </button>
      </span>
      <div style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.5 }}>{description}</div>
    </div>
  );
}

/** Catalog management: what is open, how big it is, and the things you
 * can do to it. No delete, deliberately: a catalog is the user's file
 * and removing it is theirs to do in the file browser.
 *
 * Shaped like Preferences and the user guide: the same 1.15 zoom on the
 * box (this mounts at the App root, outside every ui-zoom wrapper, so
 * without it the dialog rendered at raw scale beside chrome wearing
 * 1.15), the same header bar with the title and Close, the same 14 and
 * 13.5 type. "It needs to use the same font size as
 * Preferences and User Documentation", and the seven buttons had been
 * one wrapped row with nothing to say which of them switch catalogs and
 * which copy.*/
const CATALOG_TABS = [
  { id: "this", label: "This catalog", hint: "The catalog in use, and the ways to make, open, move or import one." },
  { id: "backup", label: "Backup and recovery", hint: "Copy the database, preserve your edits, or check a bundle." },
  { id: "known", label: "Catalogs this computer knows", hint: "Every catalog opened on this computer, and the list you can tidy." },
] as const;
type CatalogTab = (typeof CATALOG_TABS)[number]["id"];

export function CatalogDialog({
  open,
  onClose,
  dispatch,
  thumbnailEdge = 480,
}: {
  open: boolean;
  onClose: () => void;
  dispatch: D;
  thumbnailEdge?: number;
}) {
  const focus = useDialogFocus(open);
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [noteCopied, setNoteCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // The whole remembered history, not the ten the File menu shows: a
  // photographer with a catalog per wedding manages the list here
  // (2026-09-12). Availability is asked for, so a catalog on an
  // unplugged drive says so rather than looking ordinary.
  const [known, setKnown] = useState<RecentCatalog[]>([]);
  // Three panes behind one left column, the shape Preferences and the
  // user guide already use (2026-09-12). The dialog had grown four
  // stacked sections and a reader had to scroll past backups to reach
  // the list of catalogs.
  const [tab, setTab] = useState<CatalogTab>("this");
  const knownGeneration = useRef(0);
  const [knownPending, setKnownPending] = useState(false);
  const loadKnown = async () => {
    const generation = ++knownGeneration.current;
    setKnownPending(true);
    try {
      const rows = await recentCatalogs(true, true);
      if (generation === knownGeneration.current) setKnown(rows);
    } catch (e) {
      if (generation === knownGeneration.current) setNote(String(e));
    } finally {
      if (generation === knownGeneration.current) setKnownPending(false);
    }
  };
  const changeKnown = async (job: () => Promise<RecentCatalog[]>) => {
    ++knownGeneration.current;
    setBusy(true);
    setNote(null);
    try {
      const rows = await job();
      setKnown(previous => rows.map(row => previous.find(p => p.path === row.path) ?? row));
      await loadKnown();
    } catch (e) { setNote(String(e)); }
    finally { setKnownPending(false); setBusy(false); }
  };
  const reload = () => catalogInfo().then(setInfo);
  useEffect(() => {
    if (open) void reload().catch(e => setNote(String(e)));
    if (open) void loadKnown();
    return () => { ++knownGeneration.current; };
  }, [open]);
  if (!open) return null;

  /** Runs a catalog job. `switches` marks the jobs that change which
   * catalog is open. For those, the on-screen session is dropped BEFORE
   * the job runs: the debounced session saver keys off that state, and
   * letting it live through the switch is how the old catalog's folders
   * got written into the new catalog's memory. Afterwards the library is
   * rebuilt from whichever catalog is open, which on a canceled picker
   * simply puts the current one back. */
  const run = async (job: () => Promise<string | null>, switches = false) => {
    setBusy(true);
    setNote(null);
    let dropped = false;
    const problems: string[] = [];
    let result: string | null = null;
    try {
      if (switches) {
        await flushRecoverySaves();
        dispatch({ type: "begin_session_load" });
        dropped = true;
      }
      result = await job();
    } catch (e) {
      problems.push(String(e));
    } finally {
      if (dropped) {
        try { await restoreCatalogSession(dispatch, undefined, thumbnailEdge); }
        catch (e) { problems.push(`Could not restore the catalog session: ${String(e)}`); }
      }
      // Opening or importing a catalog changes what the library is
      // looking at. Without this the folder list and the tree keep
      // describing the catalog that was open a moment ago, which reads
      // as the switch having silently failed. On every exit, including
      // a canceled picker, so the current catalog is always put back.
      try { await refreshLibrary(dispatch); }
      catch (e) { problems.push(`Could not refresh the library: ${String(e)}`); }
      if (switches) await loadKnown();
      try { await reload(); }
      catch (e) { problems.push(`Could not read catalog information: ${String(e)}`); }
      setNote([result, ...problems].filter(Boolean).join(" ") || null);
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" data-testid="catalog-scrim">
      <div
        // Zoom belongs on this box, never the fixed scrim: CSS zoom
        // repositions fixed descendants. Same note as Preferences.
        ref={focus} role="dialog" aria-modal="true" aria-label="Catalogs and recovery" tabIndex={-1}
        className="modal ui-zoom"
        data-testid="catalog-dialog"
        // The box is zoomed, and so are the vh units inside it: .modal's
        // own cap of 100vh - 32px came out 1.15 times the window and the
        // header left through the top. Divided back out, the body scrolls
        // and the title bar stays put in a short window.
        // Preferences' own box, so the two management surfaces open the
        // same size and resize the same way.
        style={{ width: "min(900px, 92vw)", height: "min(700px, 86vh)", minWidth: 640, minHeight: 440, maxWidth: "96vw", maxHeight: "calc((100vh - 32px) / var(--chrome-zoom))", resize: "both", padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 14px 10px", borderBottom: "1px solid var(--line-1)", flex: "none" }}>
          <div className="kicker" style={{ fontSize: 10, letterSpacing: ".16em" }}>Catalogs and recovery</div>
          <span data-hint="Return to your photographs after the current operation finishes.">
            {/* An icon, not a word, in the same box the user guide's
                close chip wears. */}
            <button className="chip" data-testid="catalog-close" aria-label="Close" disabled={busy} style={RIBBON_ICON_CHIP} onClick={onClose}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden focusable="false">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "238px minmax(0, 1fr)", flex: 1, minHeight: 0 }}>
          <aside style={{ borderRight: "1px solid var(--line-1)", padding: "12px 10px", minHeight: 0, overflowY: "auto" }}>
            <nav aria-label="Catalog sections" style={{ display: "grid", gap: 3 }}>
              {CATALOG_TABS.map((t) => (
                <span key={t.id} data-hint={t.hint}>
                  <button
                    className="chip"
                    data-testid={`catalog-tab-${t.id}`}
                    data-active={tab === t.id}
                    aria-pressed={tab === t.id}
                    onClick={() => setTab(t.id)}
                    style={{ display: "block", boxSizing: "border-box", width: "100%", textAlign: "left", fontSize: 14, padding: "7px 9px", color: tab === t.id ? "var(--accent)" : "var(--text-body)", borderColor: "transparent" }}
                  >
                    {t.label}
                  </button>
                </span>
              ))}
            </nav>
          </aside>
          <main data-testid="catalog-pane" style={{ minWidth: 0, minHeight: 0, overflowY: "auto", padding: "2px 20px 18px" }}>
          {tab === "this" && (
            <>
            <Section title="This catalog">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  data-testid="catalog-path"
                  className="tnum"
                  style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--text-body)", wordBreak: "break-all", lineHeight: 1.45 }}
                >
                  {info?.path ?? "…"}
                </div>
                <span data-hint="Show the active database in your file browser." style={{ flex: "none" }}>
                  <button className="chip" data-testid="catalog-reveal" disabled={busy} style={{ fontSize: 11, padding: "2px 9px" }} onClick={() => void run(async () => { await revealCatalog(); return null; })}>
                    Show on disk
                  </button>
                </span>
              </div>
              {info && (
                <div data-testid="catalog-stats" className="tnum" style={{ fontSize: 13.5, color: "var(--text-ghost)", lineHeight: 1.55, marginTop: 6, maxWidth: 560 }}>
                  {info.images.toLocaleString()} photographs · {info.folders} folders ·{" "}
                  {info.hidden.toLocaleString()} hidden · {humanBytes(info.total_bytes)} on disk
                  {/* The number that decides whether a backup is a nuisance:
                      thumbnails are a cache and rebuild from the RAWs. */}
                  <div>
                    {humanBytes(info.irreplaceable_bytes)} of that cannot be regenerated. The other{" "}
                    {humanBytes(info.total_bytes - info.irreplaceable_bytes)} is thumbnail cache, cleared from Preferences, Storage.
                  </div>
                </div>
              )}
            </Section>

            <Section title="Catalog" intro="A catalog is the database that holds library records, ratings, flags, collections and presets. New and Open switch to another one; Import brings another catalog's records into this one.">
              <Action
                id="catalog-new"
                label="New catalog…"
                hint="Create an empty database and switch to it."
                description="Creates an empty catalog where you choose and switches to it. This one stays on disk, unchanged."
                disabled={busy}
                initial
                onClick={() =>
                  void run(async () => {
                    const dest = await pickCatalogDestination("catalog.sqlite");
                    if (!dest) return null;
                    const c = await createCatalog(dest);
                    return c ? `Now using the new catalog at ${c.path}.` : null;
                  }, true)
                }
              />
              <Action
                id="catalog-open"
                label="Open catalog…"
                hint="Switch to an existing catalog database."
                description="Switches to a catalog you already have. The library, folders and collections become that catalog's."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const path = await pickCatalogFile();
                    if (!path) return null;
                    const c = await openCatalogHandlingUpgrade(path);
                    return c ? `Opened ${c.path}: ${c.images.toLocaleString()} photographs.` : null;
                  }, true)
                }
              />
              <Action
                id="catalog-move"
                label="Move catalog…"
                hint="Copy this catalog to a new place, verify the copy, and switch to it."
                description="Moves this catalog where you choose: a complete copy with thumbnails is made and checked first, Heeler switches to it, and the old file is renamed beside itself with a date rather than deleted. Edits, previews and caches are not in the catalog and stay where they are."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const name = info?.path.split(/[\\/]/).pop() || "catalog.sqlite";
                    const dest = await pickCatalogDestination(name);
                    if (!dest) return null;
                    const c = await watchOp("move", () => moveCatalog(dest));
                    return c ? `The catalog now lives at ${c.path}. The old file was renamed beside its folder with the date.` : null;
                  }, true)
                }
              />
              <Action
                id="catalog-import"
                label="Import into this one…"
                hint="Merge library records into this catalog, keeping existing records."
                description="Adds another catalog's photographs and folders to this one. Records already here are kept as they are."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const path = await pickCatalogFile();
                    if (!path) return null;
                    const r = await watchOp("import", () => importCatalog(path));
                    return r
                      ? `Added ${r.images_added.toLocaleString()} photographs and ${r.folders_added} folders. ${r.images_skipped.toLocaleString()} were already here and were left as they are.`
                      : null;
                  })
                }
              />
            </Section>
            </>
          )}

          {tab === "backup" && (
            <Section
              title="Backup and recovery"
              intro="Catalog backup is the database. Recovery bundle preserves the edits, takes and user presets. Photographs and baked stack or panorama results stay at their recorded paths."
            >
              <Action
                id="catalog-backup"
                label="Catalog backup…"
                hint="Copy the database without thumbnails. Graphs and takes are preserved by Recovery bundle."
                description="Copies the database to a file you choose, thumbnails left out. Edits and takes live in graph files and are not in this copy."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const dest = await pickCatalogDestination("heeler-backup.sqlite");
                    if (!dest) return null;
                    const r = await watchOp("backup", () => backupCatalog(dest, false));
                    return r
                      ? `Backed up ${r.images.toLocaleString()} photographs to ${r.path} (${humanBytes(r.bytes)}, ${r.thumbnails_dropped} thumbnails left out).`
                      : null;
                  })
                }
              />
              <Action
                id="catalog-restore"
                label="Restore catalog from copy…"
                hint="Put a backup copy in place of this catalog, the safe way."
                description="Replaces this catalog with a copy you choose: the catalog is closed with its journal folded in, the copy is verified against its source, the current file and any journal beside it are renamed with the date rather than deleted, and the copy opens. A copy from an older Heeler meets the update prompt first. Never copy a backup over the catalog by hand: the journal left beside the live file would be applied to the copy."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const source = await pickCatalogFile();
                    if (!source) return null;
                    // The row covers the copy only; the switch that
                    // follows has its own gate and its own prompt.
                    const r = await watchOp("restore", () => restoreCatalog(source));
                    if (!r) return null;
                    forgetCatalogUpgradeApproval(r.path);
                    const opened = await switchCatalog(r.path, dispatch, thumbnailEdge);
                    return `Restored ${r.folders} folders and ${r.images.toLocaleString()} photographs from the copy. The previous catalog was renamed ${r.replaced.split(/[\\/]/).pop() ?? r.replaced} beside it. ${opened}`;
                  }, true)
                }
              />
              <Action
                id="recovery-create"
                label="Recovery bundle…"
                hint="Preserve your edits: finish pending saves, copy the database, takes and presets, and checksum referenced originals. Choose a new bundle folder name."
                description="Finishes pending saves, then writes the database, every graph and take, and your presets into a new folder, with checksums of the originals they refer to."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const dest = await pickRecoveryDestination();
                    if (!dest) return null;
                    const report = await createRecoveryBundle(dest);
                    return report ? recoveryNote(report) : null;
                  })
                }
              />
              <Action
                id="recovery-verify"
                label="Verify recovery bundle…"
                hint="Check a recovery bundle offline: read its checksums, count edits and find missing or changed original files. Nothing is restored or modified."
                description="Reads a bundle's checksums, counts its edits and reports any original file that is missing or has changed. Nothing is restored or modified."
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const path = await pickExportFolder();
                    if (!path) return null;
                    const report = await verifyRecoveryBundle(path);
                    return report ? recoveryNote(report) : null;
                  })
                }
              />
            </Section>
          )}

          {tab === "known" && (
            <Section
              title="Catalogs this computer knows"
              intro="Every catalog opened on this computer, most recent first. The File menu's Recent Catalogs shows the first ten of these. Removing one here forgets where it was and leaves the database exactly where it is."
            >
              {known.length === 0 ? (
                <div data-testid="known-catalogs-empty" style={{ fontSize: 13.5, color: "var(--text-ghost)", padding: "9px 0", borderTop: "1px solid var(--line-1)" }}>
                  {knownPending ? "Reading remembered catalogs…" : "Nothing yet. Catalogs you open appear here."}
                </div>
              ) : (
                known.map((c, i) => (
                  <div
                    key={c.path}
                    data-testid={`known-catalog-${i}`}
                    style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto auto", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--line-1)" }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, color: "var(--text-body)" }}>
                        {c.active ? "✓ " : ""}{c.name}
                        {c.exists === false && <span style={{ color: "var(--warn)" }}> (not there right now)</span>}
                        {c.exists === null && !c.active && <span style={{ color: "var(--text-ghost)" }}> ({knownPending ? "still checking" : "availability unknown"})</span>}
                      </div>
                      <div className="tnum" style={{ fontSize: 11, color: "var(--text-ghost)", wordBreak: "break-all", lineHeight: 1.4 }}>{c.path}</div>
                    </div>
                    <span data-hint={c.active ? "This is the catalog in use." : `Switch to ${c.path}.`} style={{ flex: "none" }}>
                      <button
                        className="chip"
                        data-testid={`known-catalog-open-${i}`}
                        disabled={busy || c.active === true || c.exists === false}
                        style={{ fontSize: 11, padding: "2px 9px" }}
                        onClick={() => void run(async () => { const opened = await openCatalogHandlingUpgrade(c.path); return opened ? `Opened ${opened.path}: ${opened.images.toLocaleString()} photographs.` : null; }, true)}
                      >
                        Switch
                      </button>
                    </span>
                    <span data-hint="Take this catalog off the list. The database stays where it is, and opening it again puts it back." style={{ flex: "none" }}>
                      <button
                        className="chip"
                        data-testid={`known-catalog-forget-${i}`}
                        aria-label={`Remove ${c.name} from the list`}
                        disabled={busy}
                        style={{ fontSize: 11, padding: "2px 9px" }}
                        onClick={() => void changeKnown(() => forgetRecentCatalog(c.path))}
                      >
                        Remove
                      </button>
                    </span>
                  </div>
                ))
              )}
              {known.length > 0 && (
                <div style={{ paddingTop: 10 }}>
                  <span data-hint="Empty the list. It forgets where the catalogs were and removes no file; the one in use stays open.">
                    <button
                      className="chip"
                      data-testid="known-catalogs-clear"
                      disabled={busy}
                      style={{ fontSize: 11, padding: "3px 9px" }}
                      onClick={() => void changeKnown(clearRecentCatalogs)}
                    >
                      Clear list
                    </button>
                  </span>
                </div>
              )}
            </Section>
          )}

          {/* What the last operation said, or that one is still running.
              A box rather than a loose paragraph so a long bundle report
              reads as a result and not as more instructions. */}
          {(busy || note) && (
            <div
              aria-live="polite"
              style={{ marginTop: 18, border: "1px solid var(--line-2)", borderRadius: "var(--radius-btn)", padding: "9px 12px", background: "var(--bg-app)" }}
            >
              {busy ? (
                <div data-testid="catalog-busy" style={{ fontSize: 13.5, color: "var(--text-faint)" }}>Working…</div>
              ) : (
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  {/* Selectable, in full and scrollable: a bundle's problems and missing
originals are something to paste into a report (2026-10-01: "that
text should be selectable to copy"). The app's blanket user-select
none is opted out of here, as the Console and Metadata values do.*/}
                  <div data-testid="catalog-note" style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--text-body)", lineHeight: 1.5, maxHeight: 280, overflowY: "auto", overflowWrap: "anywhere", whiteSpace: "pre-wrap", WebkitUserSelect: "text", userSelect: "text", cursor: "text" }}>
                    {note}
                  </div>
                  <span data-hint="Copy the whole result, every problem and path, to paste into a message" style={{ flex: "none" }}>
                    <button
                      className="chip"
                      data-testid="catalog-note-copy"
                      aria-label="Copy the result"
                      style={{ ...RIBBON_ICON_CHIP, ...(noteCopied ? { color: "var(--pick)", borderColor: "var(--pick)" } : {}) }}
                      onClick={() => {
                        // Optional-chained call: no clipboard (tests,
                        // odd webviews) is a no-op, as in the Console.
                        void navigator.clipboard?.writeText(note ?? "")?.then(() => {
                          setNoteCopied(true);
                          window.setTimeout(() => setNoteCopied(false), 1500);
                        });
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
                        <path d={noteCopied ? "M5 13l4 4L19 7" : "M9 9h10v11H9zM5 15V4h10"} />
                      </svg>
                    </button>
                  </span>
                </div>
              )}
            </div>
          )}
          </main>
        </div>
      </div>
    </div>
  );
}
