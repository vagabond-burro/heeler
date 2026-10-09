// The Storage preferences: the owner, "I just don't like the idea of
// temporary, and re-creatable, data just filling disk space without
// giving the user a way to manage their storage." One row per cache,
// a size, a Clear and a door.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../data";
import { reduce, type Command } from "../state";
import { Preferences } from "../ui/preferences";

// Stubbed at the window, where Tauri's own invoke lands, so every
// bridge call in the dialog reaches the same spy whichever way the
// module is loaded.
const invokeMock = vi.fn();
const names = () => invokeMock.mock.calls.map((c) => c[0] as string);

const INFO = {
  thumbnails: 120,
  thumbnail_bytes: 24 * 1024 * 1024,
  catalog_path: "/data/catalog.sqlite",
  proxies: 2,
  proxy_bytes: 700 * 1024 * 1024,
  proxies_path: "/data/proxies",
  rasters: 0,
  raster_bytes: 0,
  rasters_path: "/data/vision/smartmasks",
};

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  delete (window as any).__TAURI_INTERNALS__;
});

function openStorage() {
  (window as any).__TAURI_INTERNALS__ = { invoke: invokeMock };
  const sent: Command[] = [];
  const state = reduce(initialState(), { type: "open_prefs" });
  render(<Preferences state={state} dispatch={((c: Command) => sent.push(c)) as never} />);
  fireEvent.click(screen.getByTestId("prefs-tab-storage"));
}

describe("the Storage preferences", () => {
  it("shows each cache's count and size, and a door to where it lives", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "storage_info" ? INFO : undefined));
    openStorage();
    await waitFor(() => expect(screen.getByTestId("prefs-storage-size-thumbnails").textContent).toBe("120 · 24 MB"));
    expect(screen.getByTestId("prefs-storage-size-proxies").textContent).toBe("2 · 700 MB");
    expect(screen.getByTestId("prefs-storage-size-rasters").textContent).toBe("0 · 0 B");
    // An empty cache has nothing to clear; the door stays open.
    expect(screen.getByTestId("prefs-storage-clear-rasters")).toBeDisabled();
    expect(screen.getByTestId("prefs-storage-clear-thumbnails")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("prefs-storage-reveal-thumbnails"));
    fireEvent.click(screen.getByTestId("prefs-storage-reveal-proxies"));
    fireEvent.click(screen.getByTestId("prefs-storage-reveal-rasters"));
    await waitFor(() => expect(names()).toContain("reveal_smart_rasters"));
    expect(names()).toContain("reveal_catalog");
    expect(names()).toContain("reveal_proxies");
  });

  it("clears a cache on one click and reads the sizes again", async () => {
    let cleared = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "storage_info") return cleared ? { ...INFO, thumbnails: 0, thumbnail_bytes: 0 } : INFO;
      if (cmd === "clear_thumbnails") {
        cleared = true;
        return 120;
      }
      return undefined;
    });
    openStorage();
    await waitFor(() => expect(screen.getByTestId("prefs-storage-size-thumbnails").textContent).toBe("120 · 24 MB"));
    fireEvent.click(screen.getByTestId("prefs-storage-clear-thumbnails"));
    await waitFor(() => expect(screen.getByTestId("prefs-storage-size-thumbnails").textContent).toBe("0 · 0 B"));
    expect(names()).toContain("clear_thumbnails");
    expect(screen.getByTestId("prefs-storage-clear-thumbnails")).toBeDisabled();
    // The other caches were not touched.
    expect(names()).not.toContain("clear_proxies");
    expect(names()).not.toContain("clear_smart_rasters");
  });

  it("stays live while a reveal is still opening the folder", async () => {
    // The injected delay stands in for the slow volume: the reveal's promise stays unresolved while the
    // user moves on to another pane. Against the old synchronous
    // command the SHOW ON DISK click itself would have held the UI
    // thread until the folder check came back.
    let release!: () => void;
    const opening = new Promise<void>(r => { release = r; });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "storage_info") return Promise.resolve(INFO);
      if (cmd === "reveal_proxies") return opening;
      return Promise.resolve(undefined);
    });
    openStorage();
    await waitFor(() => expect(screen.getByTestId("prefs-storage-size-proxies").textContent).toBe("2 · 700 MB"));
    fireEvent.click(screen.getByTestId("prefs-storage-reveal-proxies"));
    await waitFor(() => expect(names()).toContain("reveal_proxies"));
    fireEvent.click(screen.getByTestId("prefs-tab-brush"));
    const dial = screen.getByTestId("prefs-grain-fine-step");
    dial.focus();
    fireEvent.keyDown(dial, { key: "ArrowRight" });
    release();
  });
});
