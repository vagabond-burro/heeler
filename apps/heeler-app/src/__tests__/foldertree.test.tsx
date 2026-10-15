// The folder tree keeping up with the disk.
//
// The tree listed each folder once and never again, so a folder made,
// renamed or removed outside Heeler showed only if its exact parent was
// opened by name; a folder that was gone did nothing when clicked; and a
// branch on an ejected card collapsed to a leaf.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../app";
import { loadSession, mockAddSubfolder, mockSetRelink, mockRemoveFolder, mockResetSessions, mockSetFolderSession, mockSetSubfolderHold } from "../bridge";
import { initialState } from "../data";
import { catalogSaves } from "../savebarrier";
import { reduce, type Command, type State, type TreeNode } from "../state";
import { EXPAND_ALL_CAP, expandAllChildren, openFolderPlain, openFolderRemembering, relinkFrom, stopExpanding } from "../ui/chrome";
import { _clearFlashForTests, currentFlash } from "../ui/hints";

type User = ReturnType<typeof userEvent.setup>;
let undo: (() => void)[] = [];

beforeEach(() => _clearFlashForTests());
afterEach(() => {
  for (const u of undo) u();
  undo = [];
});

async function openTrip(user: User) {
  await user.click(await screen.findByTestId("folder-row-3"));
  await screen.findByTestId("tree-row-mock://trip/day1");
}

async function menuOn(user: User, path: string, item: string) {
  fireEvent.contextMenu(screen.getByTestId(`tree-row-${path}`));
  await user.click(await screen.findByTestId(`folder-menu-${item}`));
}

describe("Refresh", () => {
  it("lists the open folder again: a subfolder made outside Heeler appears", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    mockAddSubfolder("mock://trip", "Day 3");
    expect(screen.queryByTestId("tree-row-mock://trip/day3")).toBeNull();
    await menuOn(user, "mock://trip", "refresh");
    expect(await screen.findByTestId("tree-row-mock://trip/day3")).toBeInTheDocument();
  });

  it("lists a folder that is not the open one", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    mockAddSubfolder("mock://trip/day1", "Morning");
    await menuOn(user, "mock://trip/day1", "refresh");
    await user.click(await screen.findByTestId("tree-toggle-mock://trip/day1"));
    expect(await screen.findByTestId("tree-row-mock://trip/day1/morning")).toBeInTheDocument();
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
  });
});

describe("expanding a branch again", () => {
  it("lists it again, so folders made since the last look show up", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    await user.click(screen.getByTestId("tree-toggle-mock://trip"));
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day1")).toBeNull());
    mockAddSubfolder("mock://trip", "Day 4");
    await user.click(screen.getByTestId("tree-toggle-mock://trip"));
    expect(await screen.findByTestId("tree-row-mock://trip/day4")).toBeInTheDocument();
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
  });
});

describe("a folder that is gone", () => {
  it("says so when clicked, leaves the library where it was, and leaves the tree", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day2"));
    await user.click(screen.getByTestId("tree-open-mock://trip/day2"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not open day2: mock:\/\/trip\/day2 is not there/));
    expect(screen.getByTestId("library-label")).toHaveTextContent("Trip");
    await waitFor(() => expect(screen.queryByTestId("tree-row-mock://trip/day2")).toBeNull());
    expect(screen.getByTestId("tree-row-mock://trip/day1")).toBeInTheDocument();
  });

  it("one that cannot be read says so rather than showing as empty", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    undo.push(mockRemoveFolder("mock://trip/day1"));
    await user.click(screen.getByTestId("tree-toggle-mock://trip/day1"));
    await waitFor(() => expect(currentFlash()).toMatch(/Could not read Day 1/));
  });
});

/** The library state behind a real reducer, for driving folder opens
 * without the panel. */
function harness() {
  let s: State = initialState();
  return {
    get: () => s,
    dispatch: (c: Command) => {
      s = reduce(s, c);
    },
  };
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

describe("re-picking a folder inside the tree", () => {
  beforeEach(() => mockResetSessions());

  // A remembered subfolder used to save the picked folder as the session's
  // root, so the next launch restored a different tree from the one on
  // screen.
  it("keeps the tree's root as the session's root when it descends to where work stopped", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    mockAddSubfolder("mock://trip/day1", "Morning");
    mockSetFolderSession("mock://trip/day1", { activeFolder: "mock://trip/day1/morning" });
    await openFolderRemembering("mock://trip/day1", h.get().folderTree, h.dispatch);
    await catalogSaves.flush();
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(await loadSession()).toMatchObject({ treeRoot: "mock://trip", activeFolder: "mock://trip/day1/morning" });
  });

  it("keeps the root for a folder deep in a branch the tree has not loaded", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    mockAddSubfolder("mock://trip/day2", "Evening");
    await openFolderPlain("mock://trip/day2/evening", h.get().folderTree, h.dispatch);
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(find(h.get().folderTree, "mock://trip/day2/evening")).not.toBeNull();
    expect(h.get().activeFolderPath).toBe("mock://trip/day2/evening");
  });

  it("puts the old tree back under a new root above it, expanded as it was", async () => {
    const h = harness();
    mockAddSubfolder("mock://trip/day1", "Noon");
    await openFolderPlain("mock://trip/day1", null, h.dispatch);
    expect(h.get().folderTree?.path).toBe("mock://trip/day1");
    await openFolderPlain("mock://trip", h.get().folderTree, h.dispatch);
    await waitFor(() => expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(true));
    expect(h.get().folderTree?.path).toBe("mock://trip");
    expect(find(h.get().folderTree, "mock://trip/day1/noon")).not.toBeNull();
  });
});

describe("Expand all children", () => {
  // A slow expand opened the branches again one by one after Collapse
  // all children.
  it("stops when the branch is collapsed while it runs", async () => {
    const h = harness();
    await openFolderPlain("mock://trip", null, h.dispatch);
    let release!: () => void;
    mockSetSubfolderHold(new Promise<void>((r) => { release = r; }));
    const running = expandAllChildren("mock://trip", h.dispatch);
    stopExpanding();
    h.dispatch({ type: "collapse_tree_below", path: "mock://trip" });
    mockSetSubfolderHold(null);
    release();
    await running;
    expect(find(h.get().folderTree, "mock://trip/day1")?.expanded).toBe(false);
    expect(find(h.get().folderTree, "mock://trip/day2")?.expanded).toBe(false);
  });

  it("says so when it reaches its cap", async () => {
    const h = harness();
    for (let i = 0; i <= EXPAND_ALL_CAP; i++) mockAddSubfolder("mock://landscapes", `F${i}`);
    await openFolderPlain("mock://landscapes", null, h.dispatch);
    await expandAllChildren("mock://landscapes", h.dispatch);
    expect(currentFlash()).toMatch(new RegExp(`Expanded the first ${EXPAND_ALL_CAP} folders`));
  });

  it("is not offered on a folder the tree does not hold", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openTrip(user);
    fireEvent.contextMenu(screen.getByTestId("folder-row-1"));
    await screen.findByTestId("folder-menu");
    expect(screen.queryByTestId("folder-menu-expand")).toBeNull();
    expect(screen.queryByTestId("folder-menu-collapse")).toBeNull();
    expect(screen.getByTestId("folder-menu-refresh")).toBeInTheDocument();
  });
});

// A relink re-reads the folder it started in when it is done, and a
// folder clicked while it ran was replaced by that one.
describe("a relink that takes a while", () => {
  afterEach(() => mockSetRelink(null));

  it("gives way to a folder clicked while it ran", async () => {
    const h = harness();
    await openFolderPlain("mock://wedding", null, h.dispatch);
    const gone = h.get().images[0].id;
    h.dispatch({ type: "select_image", id: gone });
    const before: State = { ...h.get(), images: h.get().images.map((i) => (i.id === gone ? { ...i, missing: true } : i)) };
    let release!: () => void;
    mockSetRelink("mock://elsewhere/IMG_0001.dng", new Promise<void>((r) => { release = r; }));
    const relinking = relinkFrom(before, h.dispatch);
    // The file is picked and the relink is under way before the click.
    await new Promise((r) => setTimeout(r, 0));
    await openFolderPlain("mock://trip", h.get().folderTree, h.dispatch);
    release();
    await relinking;
    expect(h.get().activeFolderPath).toBe("mock://trip");
  });
});
