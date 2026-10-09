// Phase 6 of the main-thread stalls plan: one progress row with a
// Cancel button for every long operation, fed by the heeler:progress
// event, canceling through the operation's id. These tests pin the row
// itself and the backup and move wiring at the Catalogs dialog, the
// seat the owner launches both from.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockCancels, mockEmitProgress, mockResetOps } from "../bridge";
import { CatalogDialog } from "../ui/catalogui";
import { beginOp, clearAllOps, clearOp, OpProgressOverlay } from "../ui/opprogress";

// The event bus the Tauri listen path lands on, so a test can emit what
// the Rust worker would. Faithful to Tauri: every listener on the
// channel hears the payload.
const bus = vi.hoisted(() => new Map<string, ((e: { payload: unknown }) => void)[]>());
vi.mock("@tauri-apps/api/event", () => ({
  emit: async (channel: string, payload: unknown) => {
    for (const fn of bus.get(channel) ?? []) fn({ payload });
  },
  listen: async (channel: string, fn: (e: { payload: unknown }) => void) => {
    const list = bus.get(channel) ?? [];
    list.push(fn);
    bus.set(channel, list);
    return () => bus.set(channel, (bus.get(channel) ?? []).filter((f) => f !== fn));
  },
}));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

async function emitProgress(p: { op: string; id: string; done: number; total: number; message: string }) {
  const { emit } = await import("@tauri-apps/api/event");
  await act(async () => {
    await emit("heeler:progress", p);
  });
}

afterEach(() => {
  cleanup();
  clearAllOps();
  mockResetOps();
  bus.clear();
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

describe("the one progress row", () => {
  it("shows progress from the event, and Cancel sends the id", async () => {
    render(<OpProgressOverlay />);
    expect(screen.queryByTestId("op-progress")).toBeNull();
    beginOp("backup");
    act(() => mockEmitProgress({ op: "backup", id: "backup-1", done: 6, total: 48, message: "Copying the catalog: 6 of 48 MB" }));
    const row = screen.getByTestId("op-progress-backup-1");
    expect(row).toHaveTextContent("Copying the catalog: 6 of 48 MB");
    act(() => mockEmitProgress({ op: "backup", id: "backup-1", done: 24, total: 48, message: "Copying the catalog: 24 of 48 MB" }));
    expect(screen.getByTestId("op-bar-backup-1")).toHaveStyle({ width: "50%" });
    fireEvent.click(screen.getByTestId("op-cancel-backup-1"));
    expect(mockCancels).toEqual(["backup-1"]);
    // The launcher's promise settling drops the row, either way.
    act(() => clearOp("backup"));
    expect(screen.queryByTestId("op-progress")).toBeNull();
  });

  it("a report for an operation nobody here launched, or one that already settled, raises no row", () => {
    render(<OpProgressOverlay />);
    // Not launched from this side: ignored.
    act(() => mockEmitProgress({ op: "backup", id: "backup-1", done: 6, total: 48, message: "Copying the catalog: 6 of 48 MB" }));
    expect(screen.queryByTestId("op-progress")).toBeNull();
    // Launched, reported, settled: the report that crosses the IPC
    // after the promise settled would otherwise sit with its Cancel
    // button for good.
    beginOp("backup");
    act(() => mockEmitProgress({ op: "backup", id: "backup-2", done: 6, total: 48, message: "Copying the catalog: 6 of 48 MB" }));
    expect(screen.getByTestId("op-progress-backup-2")).toBeInTheDocument();
    act(() => clearOp("backup"));
    act(() => mockEmitProgress({ op: "backup", id: "backup-2", done: 48, total: 48, message: "Copying the catalog: 48 of 48 MB" }));
    expect(screen.queryByTestId("op-progress")).toBeNull();
  });

  it("two operations run two rows at once", () => {
    render(<OpProgressOverlay />);
    beginOp("backup");
    beginOp("relink");
    act(() => mockEmitProgress({ op: "backup", id: "backup-1", done: 1, total: 4, message: "Copying the catalog: 1 of 4 MB" }));
    act(() => mockEmitProgress({ op: "relink", id: "relink-2", done: 1, total: 9, message: "Checking files: 1 of 9" }));
    expect(screen.getByTestId("op-progress-backup-1")).toBeInTheDocument();
    expect(screen.getByTestId("op-progress-relink-2")).toBeInTheDocument();
    act(() => clearOp("backup"));
    expect(screen.queryByTestId("op-progress-backup-1")).toBeNull();
    expect(screen.getByTestId("op-progress-relink-2")).toBeInTheDocument();
  });
});

describe("backup and move at the Catalogs dialog", () => {
  function openDialog() {
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "catalog_info") return { path: "/data/catalog.sqlite", images: 3, folders: 1, collections: 0, hidden: 0, thumbnails: 3, total_bytes: 48 * 1024 * 1024, irreplaceable_bytes: 1024 };
      return null;
    });
    render(
      <>
        <CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />
        <OpProgressOverlay />
      </>,
    );
  }

  it("a backup reports its copy on the row, and Cancel sends the id to the registry", async () => {
    let finish!: (r: unknown) => void;
    openDialog();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "catalog_info") return { path: "/data/catalog.sqlite", images: 3, folders: 1, collections: 0, hidden: 0, thumbnails: 3, total_bytes: 48 * 1024 * 1024, irreplaceable_bytes: 1024 };
      if (cmd === "pick_catalog_destination") return "/tmp/heeler-backup.sqlite";
      if (cmd === "backup_catalog") return new Promise((r) => { finish = r; });
      return null;
    });
    fireEvent.click(screen.getByTestId("catalog-tab-backup"));
    fireEvent.click(screen.getByTestId("catalog-backup"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("backup_catalog", { dest: "/tmp/heeler-backup.sqlite", includeThumbnails: false }));
    await emitProgress({ op: "backup", id: "backup-7", done: 12, total: 48, message: "Copying the catalog: 12 of 48 MB" });
    expect(screen.getByTestId("op-progress-backup-7")).toHaveTextContent("Copying the catalog: 12 of 48 MB");
    fireEvent.click(screen.getByTestId("op-cancel-backup-7"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "backup-7" }));
    // When the command answers, the row goes: the note carries the outcome.
    await act(async () => finish({ path: "/tmp/heeler-backup.sqlite", bytes: 48 * 1024 * 1024, images: 3, folders: 1, thumbnails_dropped: 3 }));
    await waitFor(() => expect(screen.queryByTestId("op-progress-backup-7")).toBeNull());
  });

  it("a canceled move leaves its row until the command answers, then clears", async () => {
    let fail!: (e: unknown) => void;
    openDialog();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "catalog_info") return { path: "/data/catalog.sqlite", images: 3, folders: 1, collections: 0, hidden: 0, thumbnails: 3, total_bytes: 48 * 1024 * 1024, irreplaceable_bytes: 1024 };
      if (cmd === "pick_catalog_destination") return "/tmp/elsewhere/catalog.sqlite";
      if (cmd === "move_catalog") return new Promise((_, reject) => { fail = reject; });
      return null;
    });
    // The move sits on the default "this catalog" tab.
    fireEvent.click(screen.getByTestId("catalog-move"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("move_catalog", { dest: "/tmp/elsewhere/catalog.sqlite" }));
    await emitProgress({ op: "move", id: "move-3", done: 48, total: 48, message: "Copying the catalog to its new place: 48 of 48 MB" });
    expect(screen.getByTestId("op-progress-move-3")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("op-cancel-move-3"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "move-3" }));
    await act(async () => fail(new Error("canceled; the verified copy is at /tmp/elsewhere/catalog.sqlite and the catalog was not moved")));
    await waitFor(() => expect(screen.queryByTestId("op-progress-move-3")).toBeNull());
  });

  it("a restore shows the copy's progress and Cancel sends the id", async () => {
    let finish!: (r: unknown) => void;
    openDialog();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "catalog_info") return { path: "/data/catalog.sqlite", images: 3, folders: 1, collections: 0, hidden: 0, thumbnails: 3, total_bytes: 48 * 1024 * 1024, irreplaceable_bytes: 1024 };
      if (cmd === "pick_catalog_file") return "/tmp/snapshot.sqlite";
      if (cmd === "restore_catalog") return new Promise((r) => { finish = r; });
      return null;
    });
    fireEvent.click(screen.getByTestId("catalog-tab-backup"));
    fireEvent.click(screen.getByTestId("catalog-restore"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("restore_catalog", { source: "/tmp/snapshot.sqlite" }));
    await emitProgress({ op: "restore", id: "restore-2", done: 24, total: 48, message: "Reading the copy into place: 24 of 48 MB" });
    expect(screen.getByTestId("op-progress-restore-2")).toHaveTextContent("Reading the copy into place: 24 of 48 MB");
    fireEvent.click(screen.getByTestId("op-cancel-restore-2"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "restore-2" }));
    await act(async () => finish(null));
    await waitFor(() => expect(screen.queryByTestId("op-progress-restore-2")).toBeNull());
  });

  it("an import shows rows read against the total, and Cancel sends the id", async () => {
    let fail!: (e: unknown) => void;
    openDialog();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "catalog_info") return { path: "/data/catalog.sqlite", images: 3, folders: 1, collections: 0, hidden: 0, thumbnails: 3, total_bytes: 48 * 1024 * 1024, irreplaceable_bytes: 1024 };
      if (cmd === "pick_catalog_file") return "/tmp/other.sqlite";
      if (cmd === "import_catalog") return new Promise((_, reject) => { fail = reject; });
      return null;
    });
    // The import sits on the default "this catalog" tab.
    fireEvent.click(screen.getByTestId("catalog-import"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("import_catalog", { path: "/tmp/other.sqlite" }));
    await emitProgress({ op: "import", id: "import-5", done: 400, total: 1200, message: "Merging the catalogs: 400 of 1200 rows read, 380 added" });
    expect(screen.getByTestId("op-progress-import-5")).toHaveTextContent("Merging the catalogs: 400 of 1200 rows read, 380 added");
    expect(screen.getByTestId("op-bar-import-5")).toHaveStyle({ width: "33%" });
    fireEvent.click(screen.getByTestId("op-cancel-import-5"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "import-5" }));
    await act(async () => fail(new Error("canceled; the merge was rolled back, so nothing was added")));
    await waitFor(() => expect(screen.queryByTestId("op-progress-import-5")).toBeNull());
  });
});

describe("relink from the thumbnail menu", () => {
  it("shows the sweep's progress and Cancel sends the id", async () => {
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
    let release!: (r: unknown) => void;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "pick_relink_folder") return "/moved";
      if (cmd === "relink_folder") return new Promise((r) => { release = r; });
      return [];
    });
    const { relinkFrom } = await import("../ui/chrome");
    const { initialState } = await import("../data");
    const state = {
      ...initialState(),
      images: [
        { id: "a", name: "a.nef", path: "/old/a.nef", missing: true },
        { id: "b", name: "b.nef", path: "/old/b.nef", missing: true },
      ],
      imageSelection: ["a", "b"],
    } as never;
    render(<OpProgressOverlay />);
    void relinkFrom(state, vi.fn());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("relink_folder", expect.anything()));
    await emitProgress({ op: "relink", id: "relink-4", done: 1, total: 2, message: "Checking files: 1 of 2" });
    expect(screen.getByTestId("op-progress-relink-4")).toHaveTextContent("Checking files: 1 of 2");
    fireEvent.click(screen.getByTestId("op-cancel-relink-4"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "relink-4" }));
    await act(async () => release({ relinked: 2, still_missing: 0 }));
    await waitFor(() => expect(screen.queryByTestId("op-progress-relink-4")).toBeNull());
  });
});

describe("the cache clears at the Storage preferences", () => {
  it("a proxies clear shows per-file progress and Cancel sends the id", async () => {
    const { Preferences } = await import("../ui/preferences");
    const { initialState } = await import("../data");
    const { reduce } = await import("../state");
    let release!: (r: unknown) => void;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "storage_info") return { thumbnails: 0, thumbnail_bytes: 0, catalog_path: "/data/catalog.sqlite", proxies: 5, proxy_bytes: 5000, proxies_path: "/data/proxies", rasters: 0, raster_bytes: 0, rasters_path: "/data/vision/smartmasks" };
      if (cmd === "clear_proxies") return new Promise((r) => { release = r; });
      return null;
    });
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
    const state = reduce(initialState(), { type: "open_prefs" });
    render(
      <>
        <Preferences state={state} dispatch={vi.fn() as never} />
        <OpProgressOverlay />
      </>,
    );
    fireEvent.click(screen.getByTestId("prefs-tab-storage"));
    await waitFor(() => expect(screen.getByTestId("prefs-storage-clear-proxies")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("prefs-storage-clear-proxies"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clear_proxies", undefined));
    await emitProgress({ op: "proxies", id: "proxies-6", done: 2, total: 5, message: "Removing proxies: 2 of 5" });
    expect(screen.getByTestId("op-progress-proxies-6")).toHaveTextContent("Removing proxies: 2 of 5");
    fireEvent.click(screen.getByTestId("op-cancel-proxies-6"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("cancel_operation", { id: "proxies-6" }));
    await act(async () => release(2));
    await waitFor(() => expect(screen.queryByTestId("op-progress-proxies-6")).toBeNull());
  });

  it("the thumbnails clear is a spinner, no progress row and no Cancel", async () => {
    const { Preferences } = await import("../ui/preferences");
    const { initialState } = await import("../data");
    const { reduce } = await import("../state");
    let release!: (r: unknown) => void;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "storage_info") return { thumbnails: 120, thumbnail_bytes: 1024, catalog_path: "/data/catalog.sqlite", proxies: 0, proxy_bytes: 0, proxies_path: "/data/proxies", rasters: 0, raster_bytes: 0, rasters_path: "/data/vision/smartmasks" };
      if (cmd === "clear_thumbnails") return new Promise((r) => { release = r; });
      return null;
    });
    (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
    const state = reduce(initialState(), { type: "open_prefs" });
    render(
      <>
        <Preferences state={state} dispatch={vi.fn() as never} />
        <OpProgressOverlay />
      </>,
    );
    fireEvent.click(screen.getByTestId("prefs-tab-storage"));
    await waitFor(() => expect(screen.getByTestId("prefs-storage-clear-thumbnails")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("prefs-storage-clear-thumbnails"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("clear_thumbnails", undefined));
    // One statement: a spinner on the row, and nothing on the overlay.
    await waitFor(() => expect(screen.getByTestId("prefs-storage-busy-thumbnails")).toHaveTextContent("Clearing..."));
    expect(screen.queryByTestId("op-progress")).toBeNull();
    await act(async () => release(120));
    await waitFor(() => expect(screen.queryByTestId("prefs-storage-busy-thumbnails")).toBeNull());
    expect(screen.queryByTestId("op-progress")).toBeNull();
  });
});
