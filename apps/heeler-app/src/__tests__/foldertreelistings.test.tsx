// The way down a folder takes, where an earlier listing is still in the
// tree: a branch that cannot be listed this time stops the way down a
// picked folder takes, and a restored descent overtaken by a click in the
// same tree leaves the branch it had not reached yet alone. Imports only
// what was in chrome.tsx before the tree's listings left it, so these run
// against the code before and after.

import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockAddSubfolder, mockFailListing, mockResetSessions, mockSetFolderSession, mockSetSubfolderHold } from "../bridge";
import { initialState } from "../data";
import { reduce, type Command, type State, type TreeNode } from "../state";
import { openFolderPlain, openFolderRemembering } from "../ui/chromeparts";

let undo: (() => void)[] = [];
beforeEach(() => {
  mockResetSessions();
  localStorage.removeItem("heeler.ui.treeExpanded");
});
afterEach(() => {
  for (const u of undo) u();
  undo = [];
  mockSetSubfolderHold(null);
});

function harness() {
  let s: State = initialState();
  return { get: () => s, dispatch: (c: Command) => { s = reduce(s, c); } };
}

function find(node: TreeNode | null, path: string): TreeNode | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, path);
    if (hit) return hit;
  }
  return null;
}

describe("the way down, where the tree already holds part of it", () => {
  it("stops at a branch that cannot be listed this time, even though the tree has it from before", async () => {
    mockAddSubfolder("mock://trip/day2", "Evening");
    mockAddSubfolder("mock://trip/day2/evening", "Late");
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    // Day 2 listed once, so Evening is in the tree, unlisted itself.
    await openFolderPlain("mock://trip/day2", h.get().folderTree, h.dispatch);
    expect(find(h.get().folderTree, "mock://trip/day2/evening")?.children).toBeNull();
    await openFolderPlain("mock://trip", h.get().folderTree, h.dispatch);
    undo.push(mockFailListing("mock://trip/day2"));
    await openFolderPlain("mock://trip/day2/evening/late", h.get().folderTree, h.dispatch);
    expect(find(h.get().folderTree, "mock://trip/day2/evening")?.children).toBeNull();
    expect(find(h.get().folderTree, "mock://trip/day2/evening/late")).toBeNull();
  });

  it("a restored descent overtaken by a click in the same tree leaves the rest of its way alone", async () => {
    mockAddSubfolder("mock://trip/day1", "Dawn");
    mockAddSubfolder("mock://trip/day1/dawn", "First");
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    mockSetFolderSession("mock://trip", { activeFolder: "mock://trip/day1/dawn/first" });
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    const slow = openFolderRemembering("mock://trip", h.get().folderTree, h.dispatch);
    await new Promise((r) => setTimeout(r, 0));
    mockSetSubfolderHold(null);
    const click = openFolderPlain("mock://trip/day2", h.get().folderTree, h.dispatch);
    release();
    await Promise.all([slow, click]);
    await waitFor(() => expect(h.get().activeFolderPath).toBe("mock://trip/day2"));
    expect(find(h.get().folderTree, "mock://trip/day1/dawn")?.expanded ?? false).toBe(false);
  });
});
