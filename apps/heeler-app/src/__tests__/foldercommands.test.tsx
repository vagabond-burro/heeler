// Hide folder and Flush folder (2026-09-08), and the File menu's recent
// catalogs. Hide keeps every record and asks once, only when there are
// photographs under the folder; Flush forgets the records and asks
// twice; neither touches a file. The catalog side is pinned in the
// crate's own tests; this is the words and the doors.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { mockFolderCommands, mockSetRecentCatalogs, mockSetSubtreeCounts, mockSetSubtreeCountsHold } from "../bridge";
import { initialState } from "../data";
import { promptsFor, reduce, type State } from "../state";
import { confirmCopy, isWithin } from "../ui/catalogui";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

beforeEach(() => {
  mockSetSubtreeCounts({ folders: 1, images: 0 });
  mockSetRecentCatalogs([]);
  _clearFlashForTests();
  mockSetSubtreeCountsHold(null);
});
afterEach(() => {
  cleanup();
  mockSetSubtreeCounts({ folders: 1, images: 0 });
  mockSetRecentCatalogs([]);
  mockSetSubtreeCountsHold(null);
});

async function openFolderMenu(user: ReturnType<typeof userEvent.setup>): Promise<string> {
  const row = await screen.findByTestId("folder-row-1");
  fireEvent.contextMenu(row);
  await screen.findByTestId("folder-menu");
  return row.textContent ?? "";
}

describe("Hide folder", () => {
  it("asks nothing for a folder with no photographs, hides it, and says nothing was deleted", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openFolderMenu(user);
    await user.click(screen.getByTestId("folder-menu-hide"));
    await waitFor(() => expect(mockFolderCommands).toEqual([{ command: "hide", path: expect.any(String) }]));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    await waitFor(() => expect(currentFlash()).toMatch(/Nothing was deleted/));
  });

  it("asks once, in words that say nothing is lost, when there are photographs under it", async () => {
    mockSetSubtreeCounts({ folders: 3, images: 42 });
    const user = userEvent.setup();
    render(<App />);
    await openFolderMenu(user);
    await user.click(screen.getByTestId("folder-menu-hide"));
    const body = await screen.findByTestId("confirm-body");
    expect(body).toHaveTextContent(/and the 2 folders inside it/);
    expect(body).toHaveTextContent(/Nothing is deleted or forgotten/);
    expect(body).toHaveTextContent(/42 photographs keep their ratings/);
    expect(mockFolderCommands).toEqual([]);
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(mockFolderCommands).toEqual([{ command: "hide", path: expect.any(String) }]));
    expect(promptsFor({ kind: "hide_folder", path: "/x", folders: 1, images: 1 })).toBe(1);
  });

  it("the library keeps answering while a folder's counts are on their way", async () => {
    // The injected delay stands in for the slow volume: the subtree count stays unresolved while the
    // user moves on to another folder. Against the old synchronous
    // command the Hide click itself would have held the UI thread
    // until the count came back.
    let release!: () => void;
    mockSetSubtreeCountsHold(new Promise<void>((r) => { release = r; }));
    mockSetSubtreeCounts({ folders: 3, images: 42 });
    const user = userEvent.setup();
    render(<App />);
    await openFolderMenu(user);
    await user.click(screen.getByTestId("folder-menu-hide"));
    // The next click answers while the count is still out: no confirm
    // yet, and the library still opens what was asked for.
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    await user.click(await screen.findByTestId("folder-row-3"));
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    // And the question still lands when the count comes back.
    release();
    expect(await screen.findByTestId("confirm-body")).toHaveTextContent(/42 photographs/);
  });
});

describe("Flush folder", () => {
  it("asks twice, the second page saying there is no undo, and only then flushes", async () => {
    mockSetSubtreeCounts({ folders: 1, images: 7 });
    const user = userEvent.setup();
    render(<App />);
    await openFolderMenu(user);
    await user.click(screen.getByTestId("folder-menu-flush"));
    const first = await screen.findByTestId("confirm-body");
    expect(first).toHaveTextContent(/will be forgotten by the catalog/);
    expect(first).toHaveTextContent(/The files stay where they are/);
    expect(first).toHaveTextContent(/use Hide folder instead/);
    await user.click(screen.getByTestId("confirm-ok"));
    expect(mockFolderCommands, "the first page is not the deed").toEqual([]);
    const second = await screen.findByTestId("confirm-body");
    expect(second).toHaveTextContent(/cannot be brought back once flushed/);
    expect(screen.getByTestId("confirm-title")).toHaveTextContent(/no undo/);
    await user.click(screen.getByTestId("confirm-ok"));
    await waitFor(() => expect(mockFolderCommands).toEqual([{ command: "flush", path: expect.any(String) }]));
    expect(promptsFor({ kind: "flush_folder", path: "/x", folders: 1, images: 1 })).toBe(2);
  });

  it("the words count photographs and folders honestly", () => {
    const one = confirmCopy({ action: { kind: "flush_folder", path: "/shoot/day1", folders: 1, images: 1 }, step: 2 });
    expect(one.ok).toBe("Flush 1 photograph");
    const many = confirmCopy({ action: { kind: "hide_folder", path: "C:\\shoot\\", folders: 2, images: 1200 }, step: 1 });
    expect(many.body).toMatch(/^shoot and the 1 folder inside it will leave/);
    expect(many.body).toContain("1,200 photographs");
  });
});

describe("the folder the library is showing", () => {
  it("is inside a subtree by path, whatever the separators", () => {
    expect(isWithin("/shoot/day2", "/shoot")).toBe(true);
    expect(isWithin("/shoot", "/shoot/")).toBe(true);
    expect(isWithin("/shootout", "/shoot")).toBe(false);
    expect(isWithin("C:\\shoot\\day2", "C:/shoot")).toBe(true);
  });
});

describe("Recent catalogs in the File menu", () => {
  it("lists them with the active one ticked and a missing one grayed, or says there are none", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId("menu-file"));
    // A fold-out, like Rating: the entries show once it is opened.
    expect(screen.queryByTestId("menu-file-recent-none")).toBeNull();
    await user.hover(screen.getByTestId("menu-file-recent"));
    expect(screen.getByTestId("menu-file-recent-none")).toBeDisabled();
    await user.keyboard("{Escape}");
    mockSetRecentCatalogs([
      { path: "/Users/user/Documents/Heeler/catalog.sqlite", name: "catalog.sqlite", exists: true, active: true },
      { path: "/Volumes/Photos/RAW/catalog.sqlite", name: "catalog.sqlite", exists: false, active: false },
      { path: "/Users/user/Work/clients.sqlite", name: "clients.sqlite", exists: true, active: false },
    ]);
    await user.click(screen.getByTestId("menu-file"));
    await user.hover(screen.getByTestId("menu-file-recent"));
    await waitFor(() => expect(screen.getByTestId("menu-file-recent-0")).toBeInTheDocument());
    expect(screen.getByTestId("menu-file-recent-0")).toHaveTextContent(/✓ catalog.sqlite \(Heeler\)/);
    expect(screen.getByTestId("menu-file-recent-0"), "the one in use is not a switch").toBeDisabled();
    expect(screen.getByTestId("menu-file-recent-1")).toHaveTextContent(/catalog.sqlite \(RAW\)/);
    expect(screen.getByTestId("menu-file-recent-1"), "not there right now").toBeDisabled();
    expect(screen.getByTestId("menu-file-recent-2")).toHaveTextContent(/clients.sqlite \(Work\)/);
    expect(screen.getByTestId("menu-file-recent-2")).not.toBeDisabled();
  });
});

describe("the reducer", () => {
  it("advances a two-step confirmation one page at a time", () => {
    let s: State = reduce(initialState(), { type: "ask_confirm", action: { kind: "flush_folder", path: "/x", folders: 1, images: 3 } });
    expect(s.confirm?.step).toBe(1);
    s = reduce(s, { type: "advance_confirm" });
    expect(s.confirm?.step).toBe(2);
  });
});
