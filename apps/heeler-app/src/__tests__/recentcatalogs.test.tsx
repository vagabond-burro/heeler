// Managing the list of catalogs this computer knows. 2026-09-12:
// "how does a user manage the recent catalogs list? What if a
// professional has dozens of catalogs from wedding shoots... How can
// they flush or remove select entries?"
//
// Two seats for one job. The File menu's jump list takes an entry off
// by right-click, and Catalogs and recovery lists the whole history
// with Remove on each row. Neither touches a database file.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import * as bridge from "../bridge";
import { initialState } from "../data";
import { MenuBar, relinkFrom } from "../ui/chrome";
import { CatalogDialog } from "../ui/catalogui";
import { mockSetRecentCatalogs, type RecentCatalog } from "../bridge";

const native = vi.hoisted(() => ({ invoke: vi.fn(async (_name: string): Promise<any> => []) }));
vi.mock("@tauri-apps/api/core", () => native);

const rows: RecentCatalog[] = [
  { path: "/a/wedding-may.sqlite", name: "wedding-may.sqlite", exists: true, active: true },
  { path: "/b/wedding-june.sqlite", name: "wedding-june.sqlite", exists: true, active: false },
  { path: "/Volumes/GONE/old.sqlite", name: "old.sqlite", exists: false, active: false },
];
afterEach(() => {
  mockSetRecentCatalogs([]);
  vi.restoreAllMocks();
  delete (window as any).__TAURI_INTERNALS__;
  native.invoke.mockClear();
  native.invoke.mockImplementation(async (_name: string): Promise<any> => []);
});

it("takes one catalog off the jump list from its own right-click menu", async () => {
  mockSetRecentCatalogs([...rows]);
  render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  const second = await screen.findByTestId("menu-file-recent-1");
  expect(second).toHaveTextContent("wedding-june.sqlite");
  fireEvent.contextMenu(second);
  expect(screen.getByTestId("recent-catalog-menu")).toHaveTextContent("WEDDING-JUNE.SQLITE");
  fireEvent.click(screen.getByTestId("recent-catalog-forget"));
  await waitFor(() => expect(screen.getByTestId("menu-file-recent-1")).toHaveTextContent("old.sqlite"));
  // The list forgot a path. Nothing asked to open or remove a file.
  expect(screen.queryByText(/wedding-june/)).toBeNull();
});

it("empties the jump list from the bottom of the submenu", async () => {
  mockSetRecentCatalogs([...rows]);
  render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  await screen.findByTestId("menu-file-recent-0");
  fireEvent.click(screen.getByTestId("menu-file-recent-clear"));
  // Choosing it closes the menu, as every item in this bar does, so
  // the emptiness is checked where the user would see it: next time.
  await waitFor(() => expect(screen.queryByTestId("menu-file-list")).toBeNull());
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  await waitFor(() => expect(screen.getByTestId("menu-file-recent-none")).toBeInTheDocument());
});

it("the File menu opens while a relink is still sweeping", async () => {
  (window as any).__TAURI_INTERNALS__ = { invoke: native.invoke };
  // The injected delay stands in for the drive that is still spinning up:
  // the sweep's promise stays unresolved while the user opens the File
  // menu. Against the old synchronous command the click that started the
  // relink would hold the UI thread until the sweep ended.
  let release!: () => void;
  const sweep = new Promise<any>(r => { release = () => r({ relinked: 2, still_missing: 0 }); });
  native.invoke.mockImplementation((name: string) => {
    if (name === "pick_relink_folder") return Promise.resolve("/moved");
    if (name === "relink_folder") return sweep;
    return Promise.resolve([]);
  });
  const state = {
    ...initialState(),
    images: [
      { id: "a", name: "a.nef", path: "/old/a.nef", missing: true },
      { id: "b", name: "b.nef", path: "/old/b.nef", missing: true },
    ],
    imageSelection: ["a", "b"],
  } as any;
  render(<MenuBar state={state} dispatch={vi.fn()} />);
  void relinkFrom(state, vi.fn());
  await waitFor(() => expect(native.invoke).toHaveBeenCalledWith("relink_folder", expect.anything()));
  fireEvent.click(screen.getByTestId("menu-file"));
  await waitFor(() => expect(screen.getByTestId("menu-file-list")).toBeInTheDocument());
  await act(async () => { release(); });
});

it("lists every known catalog in the dialog, with its state and a way off the list", async () => {
  mockSetRecentCatalogs([...rows]);
  render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
  // The dialog opens on the catalog in use; the list is its own pane.
  fireEvent.click(screen.getByTestId("catalog-tab-known"));
  const first = await screen.findByTestId("known-catalog-0");
  expect(first).toHaveTextContent("wedding-may.sqlite");
  expect(first).toHaveTextContent("/a/wedding-may.sqlite");
  // The one in use cannot be switched to, and a missing file cannot
  // either; both stay listed and both can be forgotten.
  expect(screen.getByTestId("known-catalog-open-0")).toBeDisabled();
  expect(screen.getByTestId("known-catalog-2")).toHaveTextContent("not there right now");
  expect(screen.getByTestId("known-catalog-open-2")).toBeDisabled();
  expect(screen.getByTestId("known-catalog-forget-2")).not.toBeDisabled();
  fireEvent.click(screen.getByTestId("known-catalog-forget-1"));
  await waitFor(() => expect(screen.queryByText(/wedding-june/)).toBeNull());
  fireEvent.click(screen.getByTestId("known-catalogs-clear"));
  await waitFor(() => expect(screen.getByTestId("known-catalogs-empty")).toBeInTheDocument());
});

it("offers the missing row's list action through Tab and Shift+F10, with Escape returning focus", async () => {
  const user = userEvent.setup();
  mockSetRecentCatalogs([...rows]);
  render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  await waitFor(() => expect(screen.getByTestId("menu-file-recent-2")).toBeDisabled());
  screen.getByTestId("menu-file-recent-1").focus();
  await user.tab();
  const origin = document.activeElement;
  expect(origin).toHaveAccessibleName("old.sqlite: Shift+F10 for list actions");
  await user.keyboard("{Shift>}{F10}{/Shift}");
  expect(screen.getByTestId("recent-catalog-forget")).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(origin).toHaveFocus();
  await user.keyboard("{Shift>}{F10}{/Shift}{Enter}");
  await waitFor(() => expect(screen.queryByTestId("menu-file-recent-2")).toBeNull());
});

it("a late probe cannot resurrect a removed menu entry", async () => {
  let finish!: (rows: RecentCatalog[]) => void;
  let removed = false;
  vi.spyOn(bridge, "recentCatalogs").mockImplementation(check => {
    if (removed) return Promise.resolve(rows.filter(r => r.path !== rows[1].path));
    return check ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(rows);
  });
  vi.spyOn(bridge, "forgetRecentCatalog").mockImplementation(async () => {
    removed = true;
    return rows.filter(r => r.path !== rows[1].path).map(r => ({ ...r, exists: null, active: null }));
  });
  render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  fireEvent.contextMenu(await screen.findByTestId("menu-file-recent-1"));
  fireEvent.click(screen.getByTestId("recent-catalog-forget"));
  await waitFor(() => expect(screen.getByTestId("menu-file-recent-1")).toHaveTextContent("old.sqlite"));
  await act(async () => finish(rows));
  expect(screen.queryByText(/wedding-june/)).toBeNull();
});

it("refreshes active and absent marks after a names-only mutation reply", async () => {
  mockSetRecentCatalogs([...rows]);
  vi.spyOn(bridge, "forgetRecentCatalog").mockImplementation(async () => {
    const left = [rows[0], rows[2]];
    mockSetRecentCatalogs(left);
    return left.map(r => ({ ...r, exists: null, active: null }));
  });
  render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("catalog-tab-known"));
  fireEvent.click(await screen.findByTestId("known-catalog-forget-1"));
  await waitFor(() => expect(screen.queryByText(/wedding-june/)).toBeNull());
  await waitFor(() => expect(screen.getByTestId("known-catalog-forget-0")).not.toBeDisabled());
  expect(screen.getByTestId("known-catalog-open-0")).toBeDisabled();
  expect(screen.getByTestId("known-catalog-open-1")).toBeDisabled();
  expect(screen.queryByText(/still checking/)).toBeNull();
});

it("shows a timed-out answer as unknown, not an indefinitely running check", async () => {
  mockSetRecentCatalogs([{ ...rows[2], exists: null, active: null }]);
  render(<CatalogDialog open onClose={vi.fn()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("catalog-tab-known"));
  expect(await screen.findByText(/availability unknown/)).toBeInTheDocument();
});

it("the bridge keeps ten menu entries and forty dialog entries, and normalizes empty native answers", async () => {
  mockSetRecentCatalogs(Array.from({ length: 40 }, (_, i) => ({ ...rows[0], path: `/p/${i}` })));
  expect(await bridge.recentCatalogs()).toHaveLength(10);
  expect(await bridge.recentCatalogs(true, true)).toHaveLength(40);
  const win = window as unknown as { __TAURI_INTERNALS__?: unknown };
  const previous = win.__TAURI_INTERNALS__;
  try {
    win.__TAURI_INTERNALS__ = { invoke: vi.fn().mockResolvedValue(null) };
    expect(await bridge.recentCatalogs()).toEqual([]);
    expect(await bridge.forgetRecentCatalog("/a")).toEqual([]);
    expect(await bridge.clearRecentCatalogs()).toEqual([]);
  } finally {
    if (previous === undefined) delete win.__TAURI_INTERNALS__;
    else win.__TAURI_INTERNALS__ = previous;
  }
});

it("switching from the dialog drops the session exactly once", async () => {
  mockSetRecentCatalogs([rows[1]]);
  const open = vi.spyOn(bridge, "openCatalog");
  const dispatch = vi.fn();
  render(<CatalogDialog open onClose={vi.fn()} dispatch={dispatch} />);
  fireEvent.click(screen.getByTestId("catalog-tab-known"));
  fireEvent.click(await screen.findByTestId("known-catalog-open-0"));
  await waitFor(() => expect(screen.getByTestId("catalog-close")).not.toBeDisabled());
  expect(open).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls.filter(([c]) => c.type === "begin_session_load")).toHaveLength(1);
});
