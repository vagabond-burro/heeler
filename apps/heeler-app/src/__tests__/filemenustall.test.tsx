import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MenuBar } from "../ui/chrome";
import { initialState } from "../data";
import { recentCatalogs, type RecentCatalog } from "../bridge";

vi.mock("../bridge", async original => ({
  ...await original<typeof import("../bridge")>(), recentCatalogs: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const row: RecentCatalog = { path: "/Volumes/Absent/catalog.sqlite", name: "catalog.sqlite", exists: null, active: null };

it("File is interactive before the list resolves, with the native command off the main thread", async () => {
  // A deferred JS mock alone would also pass the old React code. Pin
  // the real native dispatch too, or this test misses the beachball.
  const source = readFileSync(resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
  const start = source.indexOf("async fn recent_catalogs(");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  expect(body).toContain("spawn_blocking");
  vi.mocked(recentCatalogs).mockReturnValue(new Promise(() => {}));
  const dispatch = vi.fn();
  render(<MenuBar state={initialState()} dispatch={dispatch} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  expect(recentCatalogs).toHaveBeenCalled();
  fireEvent.click(screen.getByTestId("menu-file-prefs"));
  expect(dispatch).toHaveBeenCalledWith({ type: "open_prefs" });
});

it("lists names before checks, marks absence, and clears old marks while refreshing", async () => {
  let finish!: (rows: RecentCatalog[]) => void;
  vi.mocked(recentCatalogs).mockImplementation(check => check
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([row]));
  render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  const item = await screen.findByTestId("menu-file-recent-0");
  expect(item).not.toBeDisabled();
  expect(item).not.toHaveTextContent("✓");
  expect(item).not.toHaveTextContent("unknown");
  await act(async () => finish([{ ...row, exists: false, active: false }]));
  expect(item).toBeDisabled();
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  expect(await screen.findByTestId("menu-file-recent-0")).not.toBeDisabled();
  await act(async () => finish([row]));
  // Unknown says so in the hint, which is where a menu explains
  // itself, and leaves the row usable: the file may well be there.
  const row0 = screen.getByTestId("menu-file-recent-0");
  expect(row0).not.toBeDisabled();
  expect(row0).not.toHaveTextContent("unknown");
  expect(row0.closest("[data-hint]")!.getAttribute("data-hint")).toContain("Availability is unknown");
});

it("a reply from a closed menu cannot overwrite a newer list", async () => {
  let old!: (rows: RecentCatalog[]) => void;
  vi.mocked(recentCatalogs).mockReturnValueOnce(new Promise(resolve => { old = resolve; }));
  render(<MenuBar state={initialState()} dispatch={vi.fn()} />);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.click(screen.getByTestId("menu-file"));
  vi.mocked(recentCatalogs).mockResolvedValue([{ ...row, name: "new.sqlite", exists: true, active: false }]);
  fireEvent.click(screen.getByTestId("menu-file"));
  fireEvent.mouseEnter(screen.getByTestId("menu-file-recent"));
  await waitFor(() => expect(screen.getByTestId("menu-file-recent-0")).toHaveTextContent("new.sqlite"));
  await act(async () => old([{ ...row, name: "old.sqlite" }]));
  expect(screen.getByTestId("menu-file-recent-0")).toHaveTextContent("new.sqlite");
});
