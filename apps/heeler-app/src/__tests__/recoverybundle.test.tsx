import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { autosaves } from "../autosave";
import { catalogSaves, flushRecoverySaves, trackedSave } from "../savebarrier";
import { CatalogDialog, humanBytes, recoveryNote } from "../ui/catalogui";
import { backupCatalog, createRecoveryBundle } from "../bridge";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

const native = vi.hoisted(() => ({ invoke: vi.fn(async (name: string): Promise<any> => {
  if (name === "pick_recovery_destination") return "/backup/edits.heeler-recovery";
  if (name === "create_recovery_bundle" || name === "verify_recovery_bundle") return { path: "/backup/edits.heeler-recovery", complete: true, images: 1, graphs: 1, takes: 2, presets: 1, assets: 1, required_inputs: 0, app_version: "26.1.0", problems: [] };
  return null;
}) }));
vi.mock("@tauri-apps/api/core", () => native);
const defaultInvoke = native.invoke.getMockImplementation()!;
afterEach(async () => {
  await flushRecoverySaves();
  delete (window as any).__TAURI_INTERNALS__;
  native.invoke.mockClear();
  native.invoke.mockImplementation(defaultInvoke);
  _clearFlashForTests();
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe("recovery save barrier", () => {
  it("refuses to start while writes keep arming more writes", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    let writes = 0;
    const rearm = () => catalogSaves.arm("settings", 0, async () => { writes++; rearm(); });
    rearm();
    try {
      await expect(flushRecoverySaves()).rejects.toThrow("keep arriving");
      expect(writes).toBeGreaterThan(50);
      // Nothing was dropped to get there: the queued write is still queued.
      expect(catalogSaves.pendingImage()).toBe("settings");
    } finally {
      catalogSaves.cancelPending("settings");
    }
  });

  it("the storm's refusal still names a save that failed beside it", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    await expect(trackedSave("preset", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    const rearm = () => catalogSaves.arm("settings", 0, async () => { rearm(); });
    rearm();
    try {
      await expect(flushRecoverySaves()).rejects.toThrow(/keep arriving[\s\S]*disk full/);
    } finally {
      catalogSaves.cancelPending("settings");
    }
    await trackedSave("preset", async () => {});
  });

  it("awaits every photograph, settings, and an already-running preset write before snapshot", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    const graph = deferred(); const preset = deferred();
    const writes: string[] = [];
    autosaves.arm("a", 60000, async () => { await graph.promise; writes.push("a"); });
    autosaves.arm("b", 60000, async () => { writes.push("b"); });
    catalogSaves.arm("settings", 60000, async () => { writes.push("settings"); });
    const savingPreset = trackedSave("preset", () => preset.promise);
    const bundle = createRecoveryBundle("/backup/edits");
    await Promise.resolve();
    expect(native.invoke).not.toHaveBeenCalled();
    graph.resolve();
    await vi.waitFor(() => expect(writes).toContain("settings"));
    expect(native.invoke).not.toHaveBeenCalled();
    preset.resolve(); await savingPreset; await bundle;
    expect(writes.sort()).toEqual(["a", "b", "settings"]);
    expect(native.invoke).toHaveBeenCalledWith("create_recovery_bundle", { dest: "/backup/edits" });
  });
  it("blocks a bundle on failed saves and allows it after a successful retry", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
    await expect(trackedSave("broken-preset", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
    await expect(createRecoveryBundle("/backup/no")).rejects.toThrow("disk full");
    expect(native.invoke).not.toHaveBeenCalled();
    await trackedSave("broken-preset", async () => {});
    await createRecoveryBundle("/backup/yes");
    expect(native.invoke).toHaveBeenCalledWith("create_recovery_bundle", { dest: "/backup/yes" });
  });
  it("cancels only a superseded debounce, retaining an in-flight catalog save", async () => {
    const first = deferred(); const run = vi.fn(() => first.promise); const cancelled = vi.fn(async () => {});
    catalogSaves.arm("session", 0, run);
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
    catalogSaves.arm("session", 60000, cancelled);
    catalogSaves.cancelPending("session");
    let finished = false;
    const flushing = flushRecoverySaves().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    first.resolve(); await flushing;
    expect(cancelled).not.toHaveBeenCalled();
  });
});

it("names the scopes, offers workflow-ordered controls with wrapper hints, and waits visibly", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const graph = deferred();
  autosaves.arm("dialog", 60000, () => graph.promise);
  render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
  // Three panes behind a left column now, and the panes themselves
  // carry the workflow order the one long page used to: the catalog in
  // use, then backups, then the catalogs this computer knows.
  const paneButtons = () => [...screen.getByTestId("catalog-pane").querySelectorAll("button")];
  const idsIn = () => paneButtons().map(b => b.getAttribute("data-testid"));
  expect([...screen.getByTestId("catalog-dialog").querySelectorAll("nav button")].map(b => b.getAttribute("data-testid")))
    .toEqual(["catalog-tab-this", "catalog-tab-backup", "catalog-tab-known"]);
  expect(idsIn()).toContain("catalog-import");
  fireEvent.click(screen.getByTestId("catalog-tab-backup"));
  expect(screen.getByText(/Catalog backup is the database/)).toBeTruthy();
  // Every button in the dialog, the navigation included, is a chip
  // whose wrapper carries the hint; a hint on a disabled button is one
  // nobody can read.
  const buttons = [...screen.getByTestId("catalog-dialog").querySelectorAll("button")];
  for (const button of buttons) { expect(button.className).toBe("chip"); expect(button.parentElement?.getAttribute("data-hint")).toBeTruthy(); }
  const ids = idsIn();
  expect(ids.indexOf("catalog-backup")).toBeLessThan(ids.indexOf("recovery-create"));
  expect(ids.indexOf("recovery-create")).toBeLessThan(ids.indexOf("recovery-verify"));
  fireEvent.click(screen.getByTestId("recovery-create"));
  await waitFor(() => expect((screen.getByTestId("recovery-verify") as HTMLButtonElement).disabled).toBe(true));
  expect(native.invoke.mock.calls.some(([name]) => name === "create_recovery_bundle")).toBe(false);
  await act(async () => { graph.resolve(); });
  await waitFor(() => expect(screen.getByTestId("catalog-note").textContent).toContain("2 takes"));
  expect(screen.getByTestId("catalog-note").textContent).toContain("Complete");
});


it("failed tracked saves name their key even when the native error does not", async () => {
  await expect(trackedSave("presets/Print.heelerpreset", async () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  try { await expect(flushRecoverySaves()).rejects.toThrow("presets/Print.heelerpreset"); }
  finally { await trackedSave("presets/Print.heelerpreset", async () => {}); }
});

it("an older rejected save cannot revive a failure after a successful newer save", async () => {
  let reject!: (e: Error) => void;
  const older = trackedSave("same-preset", () => new Promise<void>((_, r) => { reject = r; }));
  const rejected = expect(older).rejects.toThrow("old failure");
  await trackedSave("same-preset", async () => {});
  reject(new Error("old failure"));
  await rejected;
  try { await expect(flushRecoverySaves()).resolves.toBeUndefined(); }
  finally { await trackedSave("same-preset", async () => {}); }
});

it("bounds tracked writes that keep starting more tracked writes", async () => {
  let keepGoing = true;
  let writes = 0;
  const rearm = () => trackedSave("storm", async () => { writes++; if (keepGoing) void rearm(); });
  void rearm();
  try { await expect(flushRecoverySaves()).rejects.toThrow("keep arriving"); expect(writes).toBeGreaterThan(1); }
  finally { keepGoing = false; await flushRecoverySaves(); }
});

it.each(["catalog-new", "catalog-open"])("%s flushes the old session and stays busy through restoration", async id => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const save = deferred(); const restore = deferred();
  const order: string[] = [];
  catalogSaves.arm("session", 60000, async () => { await save.promise; order.push("saved"); });
  native.invoke.mockImplementation(async name => {
    order.push(name);
    if (name.startsWith("pick_catalog")) return "/new.sqlite";
    if (name === "create_catalog" || name === "open_catalog") return { path: "/new.sqlite", images: 3 };
    if (name === "load_ui_session") { await restore.promise; return null; }
    if (name === "last_session_folder") return null;
    return name.startsWith("list_") || name.startsWith("folders_") || name === "edited_folders" ? [] : null;
  });
  render(<CatalogDialog open onClose={vi.fn()} dispatch={c => order.push(c.type)} />);
  fireEvent.click(screen.getByTestId(id));
  await act(async () => {});
  expect(order).not.toContain("begin_session_load");
  await act(async () => { save.resolve(); });
  await waitFor(() => expect(order).toContain("load_ui_session"));
  expect(order.indexOf("saved")).toBeLessThan(order.indexOf("begin_session_load"));
  expect(order.indexOf("begin_session_load")).toBeLessThan(order.indexOf(id === "catalog-new" ? "create_catalog" : "open_catalog"));
  expect(screen.getByTestId("catalog-close")).toBeDisabled();
  expect(screen.getByTestId("catalog-busy")).toHaveTextContent("Working");
  await act(async () => { restore.resolve(); });
  await waitFor(() => expect(screen.getByTestId("catalog-close")).toBeEnabled());
  expect(order).toContain("set_folders");
});

it.each(["cancel", "failure"])("a %s restores the current catalog and refreshes the library", async outcome => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const commands: any[] = [];
  native.invoke.mockImplementation(async name => {
    if (name === "pick_catalog_file") return outcome === "cancel" ? null : "/bad.sqlite";
    if (name === "open_catalog") throw new Error("not a catalog");
    if (name === "load_ui_session" || name === "last_session_folder") return null;
    if (name === "list_folders") return [{ id: 7, path: "/old" }];
    return name.startsWith("list_") || name.startsWith("folders_") || name === "edited_folders" ? [] : null;
  });
  render(<CatalogDialog open onClose={vi.fn()} dispatch={c => commands.push(c)} />);
  fireEvent.click(screen.getByTestId("catalog-open"));
  await waitFor(() => expect(commands.some(c => c.type === "set_folders")).toBe(true));
  expect(commands.find(c => c.type === "set_folders").folders).toEqual([{ id: 7, path: "/old" }]);
  expect(native.invoke).toHaveBeenCalledWith("load_ui_session", undefined);
  if (outcome === "cancel") expect(native.invoke.mock.calls.some(([name]) => name === "open_catalog")).toBe(false);
  else expect(screen.getByTestId("catalog-note")).toHaveTextContent("not a catalog");
});

it("import leaves the session in place and reports the native merge counts", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const dispatch = vi.fn();
  native.invoke.mockImplementation(async name => {
    if (name === "pick_catalog_file") return "/other.sqlite";
    if (name === "import_catalog") return { images_added: 12, folders_added: 2, images_skipped: 4, collections_added: 1 };
    return name.startsWith("list_") || name.startsWith("folders_") || name === "edited_folders" ? [] : null;
  });
  render(<CatalogDialog open onClose={vi.fn()} dispatch={dispatch} />);
  fireEvent.click(screen.getByTestId("catalog-import"));
  await waitFor(() => expect(screen.getByTestId("catalog-note")).toHaveTextContent("12 photographs and 2 folders. 4 were already here"));
  expect(dispatch).not.toHaveBeenCalledWith({ type: "begin_session_load" });
  expect(native.invoke.mock.calls.some(([name]) => name === "load_ui_session")).toBe(false);
});

it("a restore failure still refreshes the library and leaves a visible error", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  native.invoke.mockImplementation(async name => {
    if (name === "load_ui_session") throw new Error("session unavailable");
    return name.startsWith("list_") || name.startsWith("folders_") || name === "edited_folders" ? [] : null;
  });
  const dispatch = vi.fn();
  render(<CatalogDialog open onClose={vi.fn()} dispatch={dispatch} />);
  fireEvent.click(screen.getByTestId("catalog-open"));
  await waitFor(() => expect(screen.getByTestId("catalog-note")).toHaveTextContent("session unavailable"));
  expect(dispatch.mock.calls.some(([c]) => c.type === "set_folders")).toBe(true);
  expect(screen.getByTestId("catalog-close")).toBeEnabled();
});

it("scheduled backup waits for loaded settings, reports failure, and tries once", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const { useScheduledCatalogBackup } = await import("../ui/catalogbackup");
  const { logAsText } = await import("../log");
  native.invoke.mockImplementation(async name => { if (name === "run_scheduled_backup") throw new Error("backup disk unavailable"); return null; });
  const view = renderHook(({ ready, folder }) => useScheduledCatalogBackup(ready, folder, 7), { initialProps: { ready: false, folder: "" } });
  expect(native.invoke).not.toHaveBeenCalled();
  view.rerender({ ready: true, folder: "/backups" });
  await waitFor(() => expect(logAsText()).toContain("Scheduled catalog backup failed: Error: backup disk unavailable"));
  expect(currentFlash()).toContain("backup disk unavailable");
  // The native message carries the cause and the fix; the frontend adds
  // the retry once and nothing twice.
  expect(currentFlash()).toContain("next launch");
  expect(currentFlash()?.split("next launch").length).toBe(2);
  expect(native.invoke).toHaveBeenCalledWith("run_scheduled_backup", { folder: "/backups", everyDays: 7 });
  view.rerender({ ready: true, folder: "/different" });
  expect(native.invoke.mock.calls.filter(([name]) => name === "run_scheduled_backup")).toHaveLength(1);
});

it("a failed scheduled backup is put in front of the user as a dialog that opens Preferences", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  native.invoke.mockImplementation(async name => { if (name === "run_scheduled_backup") throw new Error("Backup folder is unavailable: /Volumes/Gone/Backups (No such file). Reconnect the drive or choose an existing folder in Preferences > Backup."); return null; });
  const { useScheduledCatalogBackup } = await import("../ui/catalogbackup");
  const { initialState } = await import("../data");
  const { reduce } = await import("../state");
  const { ConfirmDialog } = await import("../ui/catalogui");
  const notified: string[] = [];
  renderHook(() => useScheduledCatalogBackup(true, "/Volumes/Gone/Backups", 7, m => notified.push(m)));
  await waitFor(() => expect(notified).toHaveLength(1));
  expect(notified[0]).toContain("Reconnect the drive");
  // The notice is the confirm surface with the native message as its body.
  const sent: any[] = [];
  const s = reduce(initialState(), { type: "ask_confirm", action: { kind: "backup_failed", message: notified[0] } });
  render(<ConfirmDialog state={s} dispatch={(c: any) => sent.push(c)} />);
  expect(screen.getByTestId("confirm-title")).toHaveTextContent("Catalog backup failed");
  expect(screen.getByTestId("confirm-body")).toHaveTextContent("Reconnect the drive or choose an existing folder in Preferences > Backup");
  expect(screen.getByTestId("confirm-cancel")).toHaveTextContent("Later");
  expect(screen.getByTestId("confirm-ok")).toHaveTextContent("Open Preferences");
  fireEvent.click(screen.getByTestId("confirm-ok"));
  await waitFor(() => expect(sent).toContainEqual({ type: "open_prefs" }));
});

it.each([{ folder: "/backups", days: 0 }, { folder: "", days: 1 }])("scheduled backup enabled mid-session waits until the next launch: %j", async initial => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const { useScheduledCatalogBackup } = await import("../ui/catalogbackup");
  const view = renderHook(({ folder, days }) => useScheduledCatalogBackup(true, folder, days), { initialProps: initial });
  view.rerender({ folder: "/backups", days: 1 });
  expect(native.invoke.mock.calls.filter(([name]) => name === "run_scheduled_backup")).toHaveLength(0);
  view.unmount();
  renderHook(() => useScheduledCatalogBackup(true, "/backups", 1));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("run_scheduled_backup", { folder: "/backups", everyDays: 1 }));
  expect(native.invoke.mock.calls.filter(([name]) => name === "run_scheduled_backup")).toHaveLength(1);
});

it.each([null, { path: "/backups/heeler-catalog-100.sqlite", images: 3, bytes: 100, thumbnails_dropped: 0 }])("scheduled backup checks once in StrictMode and reports only an actual copy: %j", async result => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const { useScheduledCatalogBackup } = await import("../ui/catalogbackup");
  const { clearLog, logAsText } = await import("../log");
  clearLog();
  native.invoke.mockImplementation(async name => name === "run_scheduled_backup" ? result : null);
  const view = renderHook(({ days }) => useScheduledCatalogBackup(true, "/backups", days), {
    initialProps: { days: 1 }, wrapper: StrictMode,
  });
  await act(async () => {});
  view.rerender({ days: 7 });
  expect(native.invoke.mock.calls.filter(([name]) => name === "run_scheduled_backup")).toHaveLength(1);
  expect(logAsText().includes("Catalog backed up to")).toBe(result !== null);
  if (result) expect(logAsText()).toContain(`${result.path} (3 photographs)`);
  expect(currentFlash()).toBeNull();
});

it("Preferences answers while a scheduled backup is still running", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const { useScheduledCatalogBackup } = await import("../ui/catalogbackup");
  // The injected delay stands in for the slow volume background catalog operations
  // names: the backup promise stays unresolved while the user works.
  // Against the old synchronous command this shape could not even be
  // expressed in a browser mock, which is why the desktop test pins the
  // spawn_blocking shape and this one pins the interaction.
  const backup = deferred();
  native.invoke.mockImplementation(name => name === "run_scheduled_backup" ? backup.promise : Promise.resolve(null));
  renderHook(() => useScheduledCatalogBackup(true, "/backups", 7));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("run_scheduled_backup", { folder: "/backups", everyDays: 7 }));

  const { initialState } = await import("../data");
  const { reduce } = await import("../state");
  const { Preferences } = await import("../ui/preferences");
  const sent: any[] = [];
  const state = reduce(reduce(initialState(), { type: "open_prefs" }), { type: "set_prefs", prefs: {} });
  render(<Preferences state={state} dispatch={(c: any) => sent.push(c)} />);
  fireEvent.click(screen.getByTestId("prefs-tab-brush"));
  const dial = screen.getByTestId("prefs-grain-fine-step");
  dial.focus();
  fireEvent.keyDown(dial, { key: "ArrowRight" });
  const write = sent.find(c => c.type === "set_prefs");
  expect(write && "prefs" in write && (write.prefs as { brushGrainFineStep?: number }).brushGrainFineStep).toBe(6);
  backup.resolve();
});

it("two navigations land the newer session record, the first save still in flight", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const { applyFolderListing } = await import("../ui/chrome");
  // The injected delay stands in for the slow volume: the first
  // navigation's save is running and unresolved when the second
  // navigation arms. The queue, not call order, is what makes the newer
  // path land last (the async command no longer serializes them).
  const first = deferred();
  let saves = 0;
  native.invoke.mockImplementation(name => {
    if (name === "save_ui_session") { saves++; return saves === 1 ? first.promise : Promise.resolve(null); }
    return Promise.resolve(null);
  });
  const listing = (path: string) => ({ name: path, path, images: [], subfolders: [] });
  applyFolderListing(listing("/photos/a"), null, vi.fn());
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith(
    "save_ui_session", { treeRoot: "/photos/a", activeFolder: "/photos/a", activeImage: null },
  ), { timeout: 2000 });
  applyFolderListing(listing("/photos/b"), null, vi.fn());
  first.resolve();
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith(
    "save_ui_session", { treeRoot: "/photos/b", activeFolder: "/photos/b", activeImage: null },
  ), { timeout: 2000 });
  const calls = native.invoke.mock.calls.filter(([name]) => name === "save_ui_session");
  expect(calls).toHaveLength(2);
  const lastArgs = (calls[1] as unknown as [string, unknown])[1];
  expect(lastArgs).toEqual({ treeRoot: "/photos/b", activeFolder: "/photos/b", activeImage: null });
});

it.each([[0,"0 B"],[1023,"1023 B"],[1024,"1 KB"],[1024**2-1,"1024 KB"],[1024**2,"1.0 MB"],[1024**3-1,"1024.0 MB"],[1024**3,"1.00 GB"]])("formats the byte boundary %s", (bytes, expected) => {
  expect(humanBytes(Number(bytes))).toBe(expected);
});

it("an incomplete recovery note names problems rather than claiming matching checksums", () => {
  const note = recoveryNote({ path: "/bundle", complete: false, images: 2, graphs: 3, takes: 4, presets: 5, assets: 6, required_inputs: 7, app_version: "26.1.0", problems: ["missing photo.nef", "damaged graph"] });
  expect(note).toContain("Incomplete: 2 photographs, 3 graphs, 4 takes, 5 presets, 6 referenced assets, 7 baked inputs");
  expect(note).toContain("2 problems:\n- missing photo.nef\n- damaged graph");
  expect(note).not.toContain("Original files match");
});

// 2026-10-01: Verify recovery bundle's result was one line he
// "could not copy ... (that text should be selectable to copy)".
it("a verify result lists every problem and missing original, and is selectable and copyable", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const missing = Array.from({ length: 40 }, (_, i) => `/Volumes/DATA/P${String(i).padStart(4, "0")}.RW2`);
  native.invoke.mockImplementation(async (name: string) => {
    if (name === "pick_export_folder") return "/backup/edits.heeler-recovery";
    if (name === "verify_recovery_bundle") return {
      path: "/backup/edits.heeler-recovery", complete: false, images: 2089, graphs: 562, takes: 562, presets: 0, assets: 2214, required_inputs: 10, app_version: "26.4.0",
      problems: ["40 original files are missing (not mounted: /Volumes/DATA): /Volumes/DATA/P0000.RW2, /Volumes/DATA/P0001.RW2, /Volumes/DATA/P0002.RW2, and 37 more. The edits are in the bundle; it restores once they are back at their recorded paths", "graphs/x.json: checksum or size differs"],
      missing_originals: missing,
    };
    return null;
  });
  const writeText = vi.fn(async (_: string) => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  try {
    render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
    fireEvent.click(screen.getByTestId("catalog-tab-backup"));
    fireEvent.click(screen.getByTestId("recovery-verify"));
    const shown = await screen.findByTestId("catalog-note");
    expect(shown.textContent).toContain("2 problems:\n- 40 original files are missing (not mounted: /Volumes/DATA)");
    expect(shown.textContent).toContain("- graphs/x.json: checksum or size differs");
    expect(shown.textContent).toContain("Missing originals (40):");
    for (const p of missing) expect(shown.textContent).toContain(p);
    expect(shown.style.userSelect).toBe("text");
    expect(shown.style.whiteSpace).toBe("pre-wrap");
    expect(shown.style.overflowY).toBe("auto");
    fireEvent.click(screen.getByTestId("catalog-note-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toBe(shown.textContent);
  } finally {
    delete (navigator as any).clipboard;
  }
});

it("a new job clears the previous note and shows the catalog byte totals", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  const pending = deferred();
  native.invoke.mockImplementation(async name => {
    if (name === "catalog_info") return { path: "/catalog.sqlite", images: 2, folders: 1, collections: 0, hidden: 0, thumbnails: 1, total_bytes: 3072, irreplaceable_bytes: 1024 };
    if (name === "reveal_catalog") throw new Error("reveal failed");
    if (name === "pick_recovery_destination") { await pending.promise; return null; }
    return [];
  });
  render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId("catalog-dialog")).toHaveTextContent("3 KB"));
  expect(screen.getByTestId("catalog-dialog")).toHaveTextContent("2 KB");
  fireEvent.click(screen.getByTestId("catalog-reveal"));
  await waitFor(() => expect(screen.getByTestId("catalog-note")).toHaveTextContent("reveal failed"));
  // The note and the busy line live under every pane, so a job started
  // on one is still reported after moving to another.
  fireEvent.click(screen.getByTestId("catalog-tab-backup"));
  expect(screen.getByTestId("catalog-note")).toHaveTextContent("reveal failed");
  fireEvent.click(screen.getByTestId("recovery-create"));
  expect(screen.queryByTestId("catalog-note")).toBeNull();
  expect(screen.getByTestId("catalog-busy")).toHaveTextContent("Working");
  expect(screen.getByTestId("catalog-close")).toBeDisabled();
  await act(async () => { pending.resolve(); });
  await waitFor(() => expect(screen.getByTestId("catalog-close")).toBeEnabled());
});

it("the Catalogs and recovery panes answer while a backup is still running", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  // The injected delay stands in for the slow volume background folder queries
  // names: the backup promise stays unresolved while the user moves
  // between the dialog's panes. Against the old synchronous command the
  // click that starts the backup would not even return until the copy
  // finished.
  const backup = deferred();
  native.invoke.mockImplementation(async (name: string) => {
    if (name === "backup_catalog") { await backup.promise; return { path: "/backups/x.sqlite", bytes: 1024, images: 2, thumbnails_dropped: 3 }; }
    if (name === "pick_catalog_destination") return "/backups/x.sqlite";
    if (name === "catalog_info") return { path: "/catalog.sqlite", images: 2, folders: 1, collections: 0, hidden: 0, thumbnails: 1, total_bytes: 3072, irreplaceable_bytes: 1024 };
    return [];
  });
  render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("catalog-tab-backup"));
  fireEvent.click(screen.getByTestId("catalog-backup"));
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("backup_catalog", { dest: "/backups/x.sqlite", includeThumbnails: false }));
  expect(screen.getByTestId("catalog-busy")).toHaveTextContent("Working");
  // The tabs are not part of the busy lockout: the other panes read
  // while the copy runs.
  fireEvent.click(screen.getByTestId("catalog-tab-known"));
  await waitFor(() => expect(screen.getByTestId("known-catalogs-empty")).toBeInTheDocument());
  fireEvent.click(screen.getByTestId("catalog-tab-this"));
  await act(async () => { backup.resolve(); });
  await waitFor(() => expect(screen.getByTestId("catalog-close")).toBeEnabled());
  expect(screen.getByTestId("catalog-note")).toHaveTextContent("Backed up 2 photographs");
});

it.each([undefined, false, true])("catalog backup sends its thumbnail choice to native: %s", async include => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  await backupCatalog("/backups/catalog.sqlite", include);
  expect(native.invoke).toHaveBeenCalledWith("backup_catalog", { dest: "/backups/catalog.sqlite", includeThumbnails: include ?? false });
});
